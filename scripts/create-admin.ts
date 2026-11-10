#!/usr/bin/env node
/**
 * Tạo (hoặc cấp lại token cho) một quản trị viên — chạy trên server, không cần khóa dùng chung.
 *   npm run create-admin -- "Tên" email@congty.vn
 * Nếu email đã tồn tại: nâng lên Admin, kích hoạt lại và cấp token mới (token cũ mất hiệu lực).
 * Token chỉ in ra đúng một lần.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newToken, hashToken, tokenHint } from '../lib/tokens.js';
import { ROOT_DIR } from '../lib/paths.js';
import type { Database, User } from '../shared/types.js';

/** File dữ liệu local mà script đọc/ghi trực tiếp (không đi qua server). */
const DB_FILE = path.join(ROOT_DIR, 'data', 'db.json');

// Tham số dòng lệnh: <họ tên> <email>
const [name, emailArg] = process.argv.slice(2);
const email = String(emailArg || '')
  .trim()
  .toLowerCase();

// Kiểm tra đầu vào: cần có tên và email đúng định dạng
if (!name || !name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Cách dùng: npm run create-admin -- "Họ tên" email@congty.vn');
  process.exit(1);
}

// Đọc dữ liệu hiện có; chưa có file (lần đầu) thì bắt đầu từ dữ liệu rỗng
let db: Partial<Database> & { users: User[] } = { users: [] };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error('Không đọc được data/db.json:', (e as Error).message);
    process.exit(1);
  }
}
db.users = Array.isArray(db.users) ? db.users : [];

const now = new Date().toISOString();
const token = newToken();
// Email đã có -> nâng quyền + cấp lại token; chưa có -> tạo người dùng mới
let user: User | undefined = db.users.find((u) => u.email === email);
const existed = Boolean(user);
if (!user) {
  user = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 120),
    email,
    role: 'admin',
    active: true,
    teamId: '',
    tokenHash: '',
    tokenHint: '',
    createdAt: now,
    updatedAt: now,
  };
  db.users.push(user);
}
Object.assign(user, {
  role: 'admin',
  active: true,
  tokenHash: hashToken(token),
  tokenHint: tokenHint(token),
  tokenCreatedAt: now,
  lastUsedAt: null,
  updatedAt: now,
});

// Ghi an toàn: ghi file tạm rồi đổi tên
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
fs.renameSync(DB_FILE + '.tmp', DB_FILE);

console.log(`${existed ? 'Đã nâng lên Admin và cấp lại token cho' : 'Đã tạo quản trị viên'}: ${user.name} <${user.email}>`);
console.log('\nToken (chỉ hiển thị một lần — lưu ngay, dán vào trang "Người dùng"):\n');
console.log('  ' + token + '\n');
