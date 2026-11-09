#!/usr/bin/env node
/**
 * Tạo (hoặc cấp lại token cho) một quản trị viên — chạy trên server, không cần khóa dùng chung.
 *   npm run create-admin -- "Tên" email@congty.vn
 * Nếu email đã tồn tại: nâng lên Admin, kích hoạt lại và cấp token mới (token cũ mất hiệu lực).
 * Token chỉ in ra đúng một lần.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newToken, hashToken, tokenHint } = require('../lib/tokens');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const [name, emailArg] = process.argv.slice(2);
const email = String(emailArg || '').trim().toLowerCase();

if (!name || !name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Cách dùng: npm run create-admin -- "Họ tên" email@congty.vn');
  process.exit(1);
}

let db = {};
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('Không đọc được data/db.json:', e.message);
    process.exit(1);
  }
}
db.users = Array.isArray(db.users) ? db.users : [];

const now = new Date().toISOString();
const token = newToken();
let user = db.users.find((u) => u.email === email);
const existed = Boolean(user);
if (!user) {
  user = { id: crypto.randomUUID(), name: name.trim().slice(0, 120), email, teamId: '', createdAt: now };
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

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
fs.renameSync(DB_FILE + '.tmp', DB_FILE);

console.log(`${existed ? 'Đã nâng lên Admin và cấp lại token cho' : 'Đã tạo quản trị viên'}: ${user.name} <${user.email}>`);
console.log('\nToken (chỉ hiển thị một lần — lưu ngay, dán vào trang "Người dùng"):\n');
console.log('  ' + token + '\n');
