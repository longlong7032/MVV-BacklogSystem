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
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Database } from '../shared/types.js';

/* ---------- Kiểu dữ liệu ---------- */

/** File tải lên đang chờ được lưu (ảnh hoặc HAR). */
interface StoredUpload {
  /** Tên file lưu trữ (UUID + đuôi). */
  name: string;
  mime: string;
  size: number;
  /** Tên file gốc do người dùng chọn. */
  originalname?: string;
  buffer: Buffer;
}

/** File đọc ra từ kho lưu trữ. */
interface StoredFile {
  buffer: Buffer;
  mime: string;
}

/** Hàm chuẩn hóa dữ liệu thô (có thể là dữ liệu cũ/thiếu trường) thành `Database` hợp lệ. */
type Migrate = (raw: Record<string, unknown>) => Database;

/** Phần dữ liệu cần ghi khi commit một phiên. */
interface CommitData {
  db: Database;
  /** `true` nếu `db` đã thay đổi và cần được lưu. */
  dirty: boolean;
  uploads: StoredUpload[];
  /** Tên các file cần xóa. */
  deletes: Set<string>;
}

/** Một phiên làm việc với kho dữ liệu do driver mở (`begin`). */
interface DriverContext {
  /** Dữ liệu hiện tại đã được chuẩn hóa. */
  db: Database;
  /** Lưu thay đổi (dữ liệu + file) rồi kết thúc phiên. */
  commit(data: CommitData): Promise<void>;
  /** Hủy mọi thay đổi và nhả khóa. */
  rollback(): Promise<void>;
  /** Kết thúc phiên không có thay đổi. */
  release(): Promise<void>;
}

/** Giao diện chung của hai driver lưu trữ (file JSON / Postgres). */
interface Driver {
  mode: 'file' | 'pg';
  /** Tạo bảng/thư mục cần thiết (idempotent). */
  init(): Promise<void>;
  /** Mở phiên; `lock: true` = phiên ghi, giữ khóa đến khi commit/rollback. */
  begin(options: { lock: boolean }): Promise<DriverContext>;
  /** Đọc một file tải lên theo tên; `null` nếu không có. */
  getFile(name: string): Promise<StoredFile | null>;
}

/** Trạng thái của một phiên gắn với một request (lưu trong AsyncLocalStorage). */
interface StoreState extends CommitData {
  ctx: DriverContext;
  /** Phiên ghi (đã khóa) hay chỉ đọc. */
  locked: boolean;
}

declare global {
  namespace Express {
    interface Request {
      /** Phiên dữ liệu của request, để chạy lại trong callback của luồng mạng (vd multer). */
      dbStore?: StoreState;
    }
  }
}

/** Lưu phiên hiện tại theo ngữ cảnh bất đồng bộ, để handler gọi readDb()/writeDb() mà không phải truyền tham số. */
const als = new AsyncLocalStorage<StoreState>();

/* ---------- API đồng bộ cho handler ---------- */

/** Lấy phiên của request hiện tại; ném lỗi nếu gọi ngoài ngữ cảnh request. */
const current = (): StoreState => {
  const s = als.getStore();
  if (!s) throw new Error('readDb/writeDb được gọi ngoài ngữ cảnh request.');
  return s;
};

/** Đọc dữ liệu của phiên hiện tại (đồng bộ). */
const readDb = (): Database => current().db;

/** `true` nếu phiên hiện tại là phiên ghi (đã giữ khóa). */
const isLocked = (): boolean => Boolean(als.getStore()?.locked);

/**
 * Ghi dữ liệu vào phiên hiện tại; thực sự được lưu khi phiên commit (trước khi gửi phản hồi).
 * @throws nếu phiên chỉ đọc (request GET)
 */
function writeDb(db: Database): void {
  const s = current();
  if (!s.locked) throw new Error('Ghi dữ liệu trong request chỉ đọc (GET).');
  s.db = db;
  s.dirty = true;
}

/** Xếp hàng file tải lên: chỉ thực sự lưu khi request thành công (cùng transaction với dữ liệu). */
const queueUpload = (file: StoredUpload): number => current().uploads.push(file);

/** Xếp hàng xóa file: chỉ thực sự xóa khi request thành công. */
const queueFileDelete = (name: string): Set<string> => current().deletes.add(name);

/** MIME theo đuôi file, dùng khi đọc file từ thư mục uploads. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.har': 'application/json',
};

/* ---------- Driver: file JSON (local) ---------- */

/**
 * Mutex đơn giản dựa trên chuỗi Promise: các lời gọi `acquire()` được xếp hàng,
 * mỗi lần chỉ một bên giữ khóa cho tới khi gọi hàm `release` trả về.
 */
function mutex(): () => Promise<() => void> {
  let tail: Promise<void> = Promise.resolve();
  return async function acquire() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prev = tail;
    tail = tail.then(() => gate);
    await prev;
    return release;
  };
}

/** Tuỳ chọn tạo driver file JSON. */
interface FileDriverOptions {
  dataDir: string;
  uploadDir: string;
  migrate: Migrate;
}

/** Driver lưu `data/db.json` + thư mục `uploads/` (dùng khi chạy local). */
function createFileDriver({ dataDir, uploadDir, migrate }: FileDriverOptions): Driver {
  const dbFile = path.join(dataDir, 'db.json');
  const acquire = mutex();

  /** Đọc db.json; file thiếu/lỗi -> dữ liệu rỗng đã chuẩn hóa. */
  const load = (): Database => {
    try {
      return migrate(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
    } catch {
      return migrate({});
    }
  };
  /** Ghi db.json an toàn: ghi file tạm rồi đổi tên (tránh hỏng file nếu sập giữa chừng). */
  const save = (db: Database): void => {
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
      // Phiên ghi phải giữ mutex để hai request không ghi đè nhau; phiên đọc không cần khóa
      const release = lock ? await acquire() : () => {};
      let done = false;
      /** Nhả khóa đúng một lần dù được gọi nhiều lần. */
      const end = (): void => {
        if (!done) {
          done = true;
          release();
        }
      };
      return {
        db: load(),
        async commit(store: CommitData) {
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
      } catch {
        return null;
      }
    },
  };
}

/* ---------- Driver: Postgres ---------- */

/** Tuỳ chọn tạo driver Postgres. */
interface PgDriverOptions {
  connectionString: string;
  migrate: Migrate;
}

/** Driver lưu dữ liệu vào bảng `app_state` (jsonb) và file vào bảng `files` (bytea). */
function createPgDriver({ connectionString, migrate }: PgDriverOptions): Driver {
  const { Pool } = pg;
  // PG_POOL_MAX: số kết nối tối đa mỗi instance (mặc định 4; serverless nên để nhỏ vì nhiều instance chạy song song)
  const max = Number(process.env.PG_POOL_MAX) || 4;
  const pool = new Pool({ connectionString, max, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[pg] lỗi kết nối nhàn rỗi:', e.message));

  // Chỉ tạo bảng một lần cho mỗi instance; request đồng thời cùng chờ chung một Promise
  let initPromise: Promise<void> | null = null;
  const init = (): Promise<void> =>
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

  const noop = async (): Promise<void> => {};

  return {
    mode: 'pg',
    init,
    async begin({ lock }) {
      if (!lock) {
        // Phiên chỉ đọc: một câu SELECT, không transaction, không khóa
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

      // Phiên ghi: mở transaction và khóa dòng app_state (FOR UPDATE) cho tới khi commit/rollback
      const client = await pool.connect();
      let finished = false;
      /** ROLLBACK rồi trả kết nối về pool (an toàn khi gọi nhiều lần). */
      const rollbackAndRelease = async (): Promise<void> => {
        if (finished) return;
        finished = true;
        try {
          await client.query('ROLLBACK');
        } catch {
          // kết nối đã hỏng: bỏ qua, vẫn phải trả về pool
        }
        client.release();
      };

      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const r = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
        return {
          db: migrate((r.rows[0] && r.rows[0].data) || {}),
          async commit(store: CommitData) {
            try {
              // File tải lên cùng transaction với dữ liệu: lỗi ở đâu thì hủy tất cả
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
      const r = await pool.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM files WHERE name = $1', [path.basename(name)]);
      return r.rows[0] ? { buffer: r.rows[0].data, mime: r.rows[0].mime } : null;
    },
  };
}

/* ---------- Chọn driver theo môi trường ---------- */
/**
 * Tìm chuỗi kết nối Postgres trong biến môi trường.
 * Nhận nhiều tên biến phổ biến (Vercel + Neon tự thêm DATABASE_URL, POSTGRES_URL, ...);
 * không có thì quét biến nào có dạng postgres://
 * @returns chuỗi kết nối, hoặc '' nếu không có (-> dùng file JSON)
 */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const names = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL', 'PG_URL', 'PG4'];
  for (const n of names) if (/^postgres(ql)?:\/\//i.test(env[n] || '')) return env[n] as string;
  const found = Object.keys(env).find((k) => /^postgres(ql)?:\/\//i.test(env[k] || '') && !/NON_POOLING|UNPOOLED/i.test(k));
  return found ? env[found] || '' : '';
}

/** Tuỳ chọn tạo kho lưu trữ. */
interface StoreOptions {
  migrate: Migrate;
  dataDir: string;
  uploadDir: string;
}

/** Tuỳ chọn của middleware `dbContext`. */
interface DbContextOptions {
  /** Mặc định tự quyết theo method (ghi = khóa); đặt `false` để không khóa (MCP tự mở transaction khi cần ghi). */
  lock?: boolean;
}

/**
 * Tạo kho lưu trữ, tự chọn driver: Postgres nếu có biến kết nối, ngược lại file JSON.
 * @returns các hàm điều khiển: `init`, `getFile`, `dbContext` (middleware) và `withStore`
 */
function createStore({ migrate, dataDir, uploadDir }: StoreOptions) {
  const url = resolveDatabaseUrl();
  const driver = url ? createPgDriver({ connectionString: url, migrate }) : createFileDriver({ dataDir, uploadDir, migrate });

  /** Dựng trạng thái phiên từ ngữ cảnh driver vừa mở. */
  const makeStore = (ctx: DriverContext, locked: boolean): StoreState => ({
    ctx,
    db: ctx.db,
    locked,
    dirty: false,
    uploads: [],
    deletes: new Set<string>(),
  });

  /** Kết thúc phiên: có thay đổi thì commit, không thì chỉ nhả tài nguyên. */
  const finish = async (store: StoreState): Promise<void> => {
    if (store.dirty || store.uploads.length || store.deletes.size) await store.ctx.commit(store);
    else await store.ctx.release();
  };

  /**
   * Chạy `fn` trong một phiên riêng (dùng khi khởi động, hoặc ghi dữ liệu từ bên trong request đọc).
   * Thành công -> commit; lỗi -> rollback rồi ném lại lỗi.
   */
  async function withStore<T>(lock: boolean, fn: () => T | Promise<T>): Promise<T> {
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

  /**
   * Middleware: mỗi request /api, /mcp có phiên riêng; thay đổi được lưu ngay trước khi phản hồi được gửi đi.
   */
  const dbContext =
    (options: DbContextOptions = {}): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction) => {
      const lock = options.lock !== undefined ? options.lock : !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      let store: StoreState;
      try {
        await driver.init();
        store = makeStore(await driver.begin({ lock }), lock);
      } catch (e) {
        console.error('[db] không mở được phiên dữ liệu:', (e as Error).message);
        res.status(503).json({ error: 'Không kết nối được cơ sở dữ liệu, vui lòng thử lại sau.' });
        return;
      }

      // Chặn res.end: chỉ gửi phản hồi sau khi đã commit; commit lỗi thì thay bằng phản hồi 500
      let closed = false;
      const originalEnd = res.end;
      res.end = function (this: Response, ...args: unknown[]) {
        if (closed) return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
        closed = true;
        finish(store)
          .catch((e: Error) => {
            console.error('[db] lỗi lưu dữ liệu:', e.message);
            this.statusCode = 500;
            this.setHeader('Content-Type', 'application/json; charset=utf-8');
            this.removeHeader('Content-Length');
            args = [JSON.stringify({ error: 'Không lưu được dữ liệu, vui lòng thử lại.' })];
          })
          .then(() => (originalEnd as (...a: unknown[]) => Response).apply(this, args));
        return this;
      } as typeof res.end;
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
    getFile: (name: string) => driver.getFile(name),
    dbContext,
    withStore,
  };
}

/** Callback từ luồng mạng (multer...) không giữ ngữ cảnh request -> chạy lại `fn` trong phiên của request. */
const runInRequestStore = <T>(req: Request, fn: () => T): T => als.run(req.dbStore as StoreState, fn);

export type { StoredUpload, StoredFile, Migrate, CommitData, DriverContext, Driver };
export {
  createStore,
  createPgDriver,
  runInRequestStore,
  readDb,
  writeDb,
  isLocked,
  queueUpload,
  queueFileDelete,
  resolveDatabaseUrl,
  MIME_BY_EXT,
};
