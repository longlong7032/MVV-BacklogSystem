/**
 * Kết nối Postgres dùng chung (Neon trên production, Docker khi dev — xem docker-compose.yml ở thư mục gốc).
 *
 *  - `q(sql, params)`  chạy truy vấn; nếu đang trong `tx()` thì dùng đúng kết nối của transaction đó.
 *  - `tx(fn)`          chạy fn trong một transaction (BEGIN … COMMIT / ROLLBACK khi lỗi). Lồng nhau thì dùng chung.
 *  - `txMiddleware`    bọc mỗi request ghi (POST/PUT/PATCH/DELETE) trong một transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { NextFunction, Request, Response } from 'express';

// Kiểu trả về: DATE giữ nguyên chuỗi 'YYYY-MM-DD' (tránh lệch múi giờ), BIGINT -> number (giá trị VND / id nội bộ < 2^53)
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));

/** Tên các biến môi trường chứa chuỗi kết nối (Vercel + Neon tự thêm một trong số này). */
const URL_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL'];

/** Chuỗi kết nối Postgres; rỗng nếu chưa cấu hình. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of URL_VARS) if (env[name]) return String(env[name]);
  return '';
}

let pool: pg.Pool | null = null;

/** Pool kết nối (tạo khi dùng lần đầu). */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error('Chưa cấu hình DATABASE_URL. Local: chạy `docker compose up -d` và đặt DATABASE_URL trong backend/.env (xem .env.example).');
  }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  pool = new pg.Pool({
    connectionString,
    ssl: local || /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 3 : 10)),
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (e) => console.error('[db] lỗi kết nối nền:', e.message));
  return pool;
}

/** Kết nối của transaction hiện tại (theo ngữ cảnh bất đồng bộ). */
const als = new AsyncLocalStorage<pg.PoolClient>();

/** Chạy một truy vấn (trong transaction hiện tại nếu có). */
export async function q<T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = als.getStore();
  const res = client ? await client.query<T>(sql, params) : await getPool().query<T>(sql, params);
  return res.rows;
}

/** Truy vấn lấy một dòng; không có -> null. */
export async function q1<T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(sql, params))[0] ?? null;
}

/** Chạy `fn` trong transaction. Lỗi -> ROLLBACK và ném lại. Gọi lồng nhau thì dùng chung transaction ngoài. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (als.getStore()) return fn();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Kết nối transaction của request (để vào lại ngữ cảnh từ callback của luồng mạng, vd multer). */
const REQ_CLIENT = Symbol('dbClient');

/** Chạy `fn` trong transaction của request (nếu request đang có transaction). */
export function resumeTx<T>(req: Request, fn: () => T): T {
  const client = (req as unknown as Record<symbol, pg.PoolClient | undefined>)[REQ_CLIENT];
  return client ? als.run(client, fn) : fn();
}

/** Đang ở trong transaction không. */
export const inTx = (): boolean => Boolean(als.getStore());

/**
 * Bọc request ghi trong một transaction: COMMIT khi phản hồi 2xx/3xx, ROLLBACK khi lỗi (4xx/5xx hoặc ném lỗi).
 * Handler cứ gọi q()/tx() như bình thường.
 */
export function txMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  getPool()
    .connect()
    .then((client) => {
      let finished = false;
      const finish = async (commit: boolean): Promise<void> => {
        if (finished) return;
        finished = true;
        try {
          await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        } catch (e) {
          console.error('[db] kết thúc transaction lỗi:', (e as Error).message);
        } finally {
          client.release();
        }
      };
      // Chặn gửi phản hồi cho tới khi COMMIT xong, để client không thấy "thành công" khi dữ liệu chưa lưu
      const end = res.end.bind(res) as (...args: unknown[]) => Response;
      (res as unknown as { end: (...args: unknown[]) => Response }).end = (...args: unknown[]) => {
        void finish(res.statusCode < 400).then(() => end(...args));
        return res;
      };
      res.on('close', () => void finish(false)); // client ngắt giữa chừng
      (req as unknown as Record<symbol, pg.PoolClient>)[REQ_CLIENT] = client;
      client.query('BEGIN').then(
        () => als.run(client, next),
        (e: Error) => next(e)
      );
    }, next);
}
