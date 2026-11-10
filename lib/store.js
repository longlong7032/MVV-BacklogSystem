/**
 * Lớp lưu trữ dữ liệu cho cả hai môi trường:
 *  - Postgres (Neon, Vercel...) khi có biến kết nối DB (DATABASE_URL, POSTGRES_URL, ...)
 *  - File JSON + thư mục uploads khi chạy local (không có biến DB) — không đụng dữ liệu production.
 *
 * Toàn bộ dữ liệu dạng "tài liệu" (projects, teams, users, feedbacks, ...) nằm trong 1 dòng bảng app_state (jsonb);
 * ảnh / file HAR nằm trong bảng files (bytea) vì Vercel không cho ghi ổ đĩa.
 *
 * Mỗi request được bọc trong 1 "store" (AsyncLocalStorage) để handler dùng readDb() / writeDb() đồng bộ như cũ:
 *  - request ghi (POST/PUT/PATCH/DELETE): mở transaction + khóa dòng (FOR UPDATE) -> hai request đồng thời không ghi đè nhau
 *  - request đọc (GET): chỉ đọc bản hiện tại, không khóa
 *  - thay đổi được lưu (cùng transaction với file tải lên / xóa file) ngay trước khi gửi phản hồi.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const als = new AsyncLocalStorage();

/* ---------- API đồng bộ cho handler ---------- */
const current = () => {
  const s = als.getStore();
  if (!s) throw new Error('readDb/writeDb được gọi ngoài ngữ cảnh request.');
  return s;
};
const readDb = () => current().db;
const isLocked = () => Boolean(als.getStore() && als.getStore().locked);

function writeDb(db) {
  const s = current();
  if (!s.locked) throw new Error('Ghi dữ liệu trong request chỉ đọc (GET).');
  s.db = db;
  s.dirty = true;
}

// File tải lên: chỉ thực sự lưu khi request thành công (cùng transaction với dữ liệu)
const queueUpload = (file) => current().uploads.push(file);
const queueFileDelete = (name) => current().deletes.add(name);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.har': 'application/json',
};

/* ---------- Driver: file JSON (local) ---------- */
function mutex() {
  let tail = Promise.resolve();
  return async function acquire() {
    let release;
    const gate = new Promise((r) => (release = r));
    const prev = tail;
    tail = tail.then(() => gate);
    await prev;
    return release;
  };
}

function createFileDriver({ dataDir, uploadDir, migrate }) {
  const dbFile = path.join(dataDir, 'db.json');
  const acquire = mutex();

  const load = () => {
    try {
      return migrate(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
    } catch (e) {
      return migrate({});
    }
  };
  const save = (db) => {
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(dbFile + '.tmp', dbFile);
  };

  return {
    mode: 'file',
    async init() {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(uploadDir, { recursive: true });
      if (fs.existsSync(dbFile)) save(load()); // lưu lại dữ liệu đã chuẩn hóa
    },
    async begin({ lock }) {
      const release = lock ? await acquire() : () => {};
      let done = false;
      const end = () => {
        if (!done) {
          done = true;
          release();
        }
      };
      return {
        db: load(),
        async commit(store) {
          try {
            if (store.dirty) save(store.db);
            for (const u of store.uploads) {
              if (!store.deletes.has(u.name)) fs.writeFileSync(path.join(uploadDir, u.name), u.buffer);
            }
            for (const name of store.deletes) fs.unlink(path.join(uploadDir, path.basename(name)), () => {});
          } finally {
            end();
          }
        },
        rollback: async () => end(),
        release: async () => end(),
      };
    },
    async getFile(name) {
      try {
        const buffer = fs.readFileSync(path.join(uploadDir, path.basename(name)));
        return { buffer, mime: MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream' };
      } catch (e) {
        return null;
      }
    },
  };
}

/* ---------- Driver: Postgres ---------- */
function createPgDriver({ connectionString, migrate }) {
  const { Pool } = pg;
  // PG_POOL_MAX: số kết nối tối đa mỗi instance (mặc định 4; serverless nên để nhỏ vì nhiều instance chạy song song)
  const max = Number(process.env.PG_POOL_MAX) || 4;
  const pool = new Pool({ connectionString, max, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[pg] lỗi kết nối nhàn rỗi:', e.message));

  let initPromise = null;
  const init = () =>
    (initPromise ||= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
        id int PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS files (
        name text PRIMARY KEY,
        mime text NOT NULL,
        size int NOT NULL,
        original_name text,
        data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await pool.query(`INSERT INTO app_state (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    })().catch((e) => {
      initPromise = null; // cho phép thử lại ở request sau
      throw e;
    }));

  const noop = async () => {};

  return {
    mode: 'pg',
    init,
    async begin({ lock }) {
      if (!lock) {
        const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
        return {
          db: migrate((r.rows[0] && r.rows[0].data) || {}),
          commit: async () => {
            throw new Error('Request chỉ đọc không được lưu dữ liệu.');
          },
          rollback: noop,
          release: noop,
        };
      }

      const client = await pool.connect();
      let finished = false;
      const rollbackAndRelease = async () => {
        if (finished) return;
        finished = true;
        try {
          await client.query('ROLLBACK');
        } catch (e) {}
        client.release();
      };

      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const r = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
        return {
          db: migrate((r.rows[0] && r.rows[0].data) || {}),
          async commit(store) {
            try {
              for (const u of store.uploads) {
                if (store.deletes.has(u.name)) continue;
                await client.query(
                  'INSERT INTO files (name, mime, size, original_name, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING',
                  [u.name, u.mime, u.size, u.originalname || null, u.buffer]
                );
              }
              if (store.dirty) {
                await client.query('UPDATE app_state SET data = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(store.db)]);
              }
              if (store.deletes.size) {
                await client.query('DELETE FROM files WHERE name = ANY($1)', [[...store.deletes].map((n) => path.basename(n))]);
              }
              await client.query('COMMIT');
              finished = true;
              client.release();
            } catch (e) {
              await rollbackAndRelease();
              throw e;
            }
          },
          rollback: rollbackAndRelease,
          release: rollbackAndRelease, // không có thay đổi -> ROLLBACK cho nhẹ
        };
      } catch (e) {
        await rollbackAndRelease();
        throw e;
      }
    },
    async getFile(name) {
      const r = await pool.query('SELECT mime, data FROM files WHERE name = $1', [path.basename(name)]);
      return r.rows[0] ? { buffer: r.rows[0].data, mime: r.rows[0].mime } : null;
    },
  };
}

/* ---------- Chọn driver theo môi trường ---------- */
// Nhận nhiều tên biến phổ biến (Vercel + Neon tự thêm DATABASE_URL, POSTGRES_URL, ...); không có thì quét biến nào có dạng postgres://
function resolveDatabaseUrl(env = process.env) {
  const names = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL', 'PG_URL', 'PG4'];
  for (const n of names) if (/^postgres(ql)?:\/\//i.test(env[n] || '')) return env[n];
  const found = Object.keys(env).find((k) => /^postgres(ql)?:\/\//i.test(env[k] || '') && !/NON_POOLING|UNPOOLED/i.test(k));
  return found ? env[found] : '';
}

function createStore({ migrate, dataDir, uploadDir }) {
  const url = resolveDatabaseUrl();
  const driver = url ? createPgDriver({ connectionString: url, migrate }) : createFileDriver({ dataDir, uploadDir, migrate });

  const makeStore = (ctx, locked) => ({ ctx, db: ctx.db, locked, dirty: false, uploads: [], deletes: new Set() });

  const finish = async (store) => {
    if (store.dirty || store.uploads.length || store.deletes.size) await store.ctx.commit(store);
    else await store.ctx.release();
  };

  // Chạy fn trong 1 store riêng (dùng khi khởi động, hoặc ghi dữ liệu từ bên trong request đọc)
  async function withStore(lock, fn) {
    await driver.init();
    const store = makeStore(await driver.begin({ lock }), lock);
    try {
      const result = await als.run(store, fn);
      await finish(store);
      return result;
    } catch (e) {
      await store.ctx.rollback().catch(() => {});
      throw e;
    }
  }

  // Middleware: mỗi request /api, /mcp có store riêng; lưu ngay trước khi phản hồi được gửi đi.
  // options.lock: mặc định tự quyết theo method (ghi = khóa); đặt false để không khóa (MCP tự mở transaction khi cần ghi)
  const dbContext = (options = {}) => async (req, res, next) => {
    const lock = options.lock !== undefined ? options.lock : !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    let store;
    try {
      await driver.init();
      store = makeStore(await driver.begin({ lock }), lock);
    } catch (e) {
      console.error('[db] không mở được phiên dữ liệu:', e.message);
      return res.status(503).json({ error: 'Không kết nối được cơ sở dữ liệu, vui lòng thử lại sau.' });
    }

    let closed = false;
    const originalEnd = res.end;
    res.end = function (...args) {
      if (closed) return originalEnd.apply(this, args);
      closed = true;
      finish(store)
        .catch((e) => {
          console.error('[db] lỗi lưu dữ liệu:', e.message);
          this.statusCode = 500;
          this.setHeader('Content-Type', 'application/json; charset=utf-8');
          this.removeHeader('Content-Length');
          args = [JSON.stringify({ error: 'Không lưu được dữ liệu, vui lòng thử lại.' })];
        })
        .then(() => originalEnd.apply(this, args));
      return this;
    };
    // Client ngắt kết nối giữa chừng -> hủy transaction, nhả khóa
    res.on('close', () => {
      if (!closed) {
        closed = true;
        store.ctx.rollback().catch(() => {});
      }
    });

    req.dbStore = store; // để chạy lại trong ngữ cảnh này sau các callback của luồng mạng (vd multer)
    als.run(store, next);
  };

  return {
    mode: driver.mode,
    init: () => driver.init(),
    getFile: (name) => driver.getFile(name),
    dbContext,
    withStore,
  };
}

// Callback từ luồng mạng (multer...) không giữ ngữ cảnh request -> chạy lại fn trong store của request
const runInRequestStore = (req, fn) => als.run(req.dbStore, fn);

export { createStore, createPgDriver, runInRequestStore, readDb, writeDb, isLocked, queueUpload, queueFileDelete, resolveDatabaseUrl, MIME_BY_EXT };
