#!/usr/bin/env node
/**
 * Tạo (hoặc cấp lại token cho) một quản trị viên — chạy trên máy có quyền truy cập DATABASE_URL.
 *   npm run create-admin -- "Họ tên" email@congty.vn ["mật-khẩu"]
 * Có mật khẩu (tối thiểu 8 ký tự): đặt mật khẩu đăng nhập; không có: cấp token cá nhân.
 * Email đã tồn tại: nâng lên Admin, kích hoạt lại và cấp token mới (token cũ mất hiệu lực). Token chỉ in ra một lần.
 */
import '../lib/env.js';
import { getPool, q1, tx } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { uuidv7 } from '../lib/ids.js';
import { newToken, hashToken, tokenHint, hashPassword } from '../lib/tokens.js';

const [nameArg, emailArg, passwordArg] = process.argv.slice(2);
const password = String(passwordArg || '');
const name = String(nameArg || '').trim().slice(0, 120);
const email = String(emailArg || '').trim().toLowerCase();
if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Cách dùng: npm run create-admin -- "Họ tên" email@congty.vn ["mật-khẩu"]');
  process.exit(1);
}
if (password && password.length < 8) {
  console.error('Mật khẩu tối thiểu 8 ký tự.');
  process.exit(1);
}

try {
  await runMigrations(() => {});
  // Có mật khẩu: lưu băm mật khẩu (không đụng token). Không: cấp token cá nhân mới.
  const token = password ? '' : newToken();
  const cred = password
    ? { sql: 'password_hash = $2', val: [hashPassword(password)] }
    : { sql: 'token_hash = $2, token_hint = $3, token_created_at = now(), last_used_at = NULL', val: [hashToken(token), tokenHint(token)] };
  const existed = await tx(async () => {
    const user = await q1('SELECT id_private FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE', [email]);
    if (user) {
      await q1(`UPDATE users SET role = 'admin', active = true, ${cred.sql} WHERE id_private = $1`, [user.id_private, ...cred.val]);
    } else if (password) {
      await q1("INSERT INTO users (id_public, name, email, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)", [uuidv7(), name, email, ...cred.val]);
    } else {
      await q1("INSERT INTO users (id_public, name, email, role, token_hash, token_hint, token_created_at) VALUES ($1, $2, $3, 'admin', $4, $5, now())", [uuidv7(), name, email, ...cred.val]);
    }
    await q1('INSERT INTO audit_logs (id_public, actor, action, target) VALUES ($1, $2, $3, $4)', [uuidv7(), 'dòng lệnh', `${user ? 'cập nhật' : 'tạo'} admin (${password ? 'mật khẩu' : 'token'})`, name]);
    return Boolean(user);
  });
  console.log(`${existed ? 'Đã nâng lên Admin và cập nhật thông tin đăng nhập cho' : 'Đã tạo quản trị viên'}: ${name} <${email}>`);
  if (password) console.log('Đăng nhập bằng email và mật khẩu vừa đặt; có thể đổi mật khẩu ở trang Hồ sơ.');
  else console.log('\nToken (chỉ hiển thị một lần — lưu ngay, dán vào trang "Người dùng"):\n\n  ' + token + '\n');
} catch (e) {
  console.error('Lỗi:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await getPool().end();
}
