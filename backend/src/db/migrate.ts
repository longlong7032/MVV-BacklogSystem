/**
 * Chạy các migration chưa áp dụng (MIGRATIONS trong migrations.ts), mỗi migration trong một transaction.
 * Dùng advisory lock để nhiều instance (Vercel) khởi động cùng lúc không chạy trùng.
 *
 *   npm run db:migrate      # chạy tay
 *   (server cũng tự gọi runMigrations() khi khởi động)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPool } from './pool.js';
import { MIGRATIONS } from './migrations.js';
import { uuidv7 } from '../lib/ids.js';

/** Khóa advisory cố định cho việc migrate. */
const LOCK_ID = 727_001;

export async function runMigrations(log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    // Bảng ghi lại migration đã chạy — cũng theo quy ước cột chuẩn
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id_private  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_public   UUID NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at  TIMESTAMPTZ,
      name        TEXT NOT NULL UNIQUE
    )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations WHERE deleted_at IS NULL')).rows.map((r) => r.name));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id_public, name) VALUES ($1, $2)', [uuidv7(), m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
        log(`[db] đã áp dụng migration ${m.id}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.id} lỗi: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}

// Chạy trực tiếp: tsx src/db/migrate.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('../lib/env.js');
  runMigrations()
    .then((list) => {
      console.log(list.length ? `Xong: ${list.join(', ')}` : 'Schema đã mới nhất.');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
