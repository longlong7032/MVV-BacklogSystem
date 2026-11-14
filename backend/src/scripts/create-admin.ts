#!/usr/bin/env node
/**
 * Tạo (hoặc cấp lại token cho) một quản trị viên — chạy trên máy có quyền truy cập DATABASE_URL.
 *   npm run create-admin -- "Họ tên" email@congty.vn
 * Email đã tồn tại: nâng lên Admin, kích hoạt lại và cấp token mới (token cũ mất hiệu lực). Token chỉ in ra một lần.
 */
import '../lib/env.js';
import { getPool, q1, tx } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { uuidv7 } from '../lib/ids.js';
import { newToken, hashToken, tokenHint } from '../lib/tokens.js';

const [nameArg, emailArg] = process.argv.slice(2);
const name = String(nameArg || '').trim().slice(0, 120);
const email = String(emailArg || '').trim().toLowerCase();
if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Cách dùng: npm run create-admin -- "Họ tên" email@congty.vn');
  process.exit(1);
}

try {
  await runMigrations(() => {});
  const token = newToken();
  const existed = await tx(async () => {
    const user = await q1('SELECT id_private FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE', [email]);
    const fields = [hashToken(token), tokenHint(token)];
    if (user) {
      await q1("UPDATE users SET role = 'admin', active = true, token_hash = $2, token_hint = $3, token_created_at = now(), last_used_at = NULL WHERE id_private = $1", [user.id_private, ...fields]);
    } else {
      await q1("INSERT INTO users (id_public, name, email, role, token_hash, token_hint, token_created_at) VALUES ($1, $2, $3, 'admin', $4, $5, now())", [uuidv7(), name, email, ...fields]);
    }
    await q1('INSERT INTO audit_logs (id_public, actor, action, target) VALUES ($1, $2, $3, $4)', [uuidv7(), 'dòng lệnh', user ? 'cấp lại token admin' : 'tạo admin', name]);
    return Boolean(user);
  });
  console.log(`${existed ? 'Đã nâng lên Admin và cấp lại token cho' : 'Đã tạo quản trị viên'}: ${name} <${email}>`);
  console.log('\nToken (chỉ hiển thị một lần — lưu ngay, dán vào trang "Người dùng"):\n');
  console.log('  ' + token + '\n');
} catch (e) {
  console.error('Lỗi:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await getPool().end();
}
