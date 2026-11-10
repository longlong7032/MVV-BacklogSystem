#!/usr/bin/env node
/**
 * Chuyển dữ liệu local (data/db.json + thư mục uploads) lên Postgres.
 *
 *   DATABASE_URL="postgresql://..." npm run migrate-to-pg -- --dry-run   # chỉ xem sẽ chuyển gì
 *   DATABASE_URL="postgresql://..." npm run migrate-to-pg                # chuyển thật
 *
 * - Không ghi đè: nếu DB đích đã có dữ liệu (dự án / backlog / người dùng) thì dừng, trừ khi thêm --force.
 * - Không bao giờ in chuỗi kết nối. Biến môi trường: DATABASE_URL (hoặc POSTGRES_URL...).
 * - DATA_DIR / UPLOAD_DIR đổi nơi đọc dữ liệu local (mặc định ./data, ./uploads).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPgDriver, resolveDatabaseUrl, MIME_BY_EXT } from '../lib/store.js';
import type { StoredUpload } from '../lib/store.js';
import { ROOT_DIR } from '../lib/paths.js';
import type { Database } from '../types.js';

// Cờ dòng lệnh: --dry-run (chỉ xem), --force (ghi đè DB đích đã có dữ liệu)
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

const url = resolveDatabaseUrl();
if (!url) {
  console.error('Thiếu chuỗi kết nối: đặt biến DATABASE_URL (hoặc POSTGRES_URL).');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT_DIR, 'uploads');
const dbFile = path.join(dataDir, 'db.json');

// Đọc dữ liệu local
let doc: Database;
try {
  doc = JSON.parse(fs.readFileSync(dbFile, 'utf8')) as Database;
} catch (e) {
  console.error(`Không đọc được ${dbFile}: ${(e as Error).message}`);
  process.exit(1);
}
// Bảo đảm đủ các mảng (file cũ có thể thiếu)
for (const k of ['projects', 'teams', 'users', 'feedbacks', 'audit'] as const) {
  (doc[k] as unknown[]) = Array.isArray(doc[k]) ? doc[k] : [];
}
doc.sessions = {}; // phiên đăng nhập cũ không mang sang

// Các file được tham chiếu trong dữ liệu (ảnh vị trí / mô tả / kết quả mong muốn và HAR)
const urls = new Set<string>();
for (const f of doc.feedbacks) {
  [f.location && f.location.image, ...((f.bug && f.bug.images) || []), ...((f.expected && f.expected.images) || []), f.har && f.har.url]
    .filter((u): u is string => typeof u === 'string' && u.startsWith('/uploads/'))
    .forEach((u) => urls.add(u));
}
const uploads: StoredUpload[] = [];
const missing: string[] = [];
for (const u of urls) {
  const name = path.basename(u);
  const file = path.join(uploadDir, name);
  if (!fs.existsSync(file)) {
    missing.push(name);
    continue;
  }
  const buffer = fs.readFileSync(file);
  uploads.push({
    name,
    mime: MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream',
    size: buffer.length,
    originalname: name,
    buffer,
  });
}

/** Đổi byte sang MB (1 chữ số thập phân) để in ra. */
const mb = (n: number): string => (n / 1048576).toFixed(1) + 'MB';
console.log('Sẽ chuyển:');
console.log(`  ${doc.projects.length} dự án, ${doc.teams.length} team, ${doc.users.length} người dùng, ${doc.feedbacks.length} backlog`);
console.log(`  ${uploads.length} file đính kèm (${mb(uploads.reduce((n, u) => n + u.size, 0))})`);
if (missing.length) console.log(`  CẢNH BÁO: ${missing.length} file được tham chiếu nhưng không có trong ${uploadDir} (bỏ qua)`);
if (dryRun) {
  console.log('\n--dry-run: chưa ghi gì vào database.');
  process.exit(0);
}

// Chuyển thật: mở phiên ghi có khóa, kiểm tra DB đích rỗng, rồi commit dữ liệu + file trong một transaction
(async () => {
  const driver = createPgDriver({ connectionString: url, migrate: (d) => d as unknown as Database });
  await driver.init();
  const ctx = await driver.begin({ lock: true });
  try {
    const existing: Partial<Database> = ctx.db || {};
    const has = (['projects', 'feedbacks', 'users', 'teams'] as const).some((k) => Array.isArray(existing[k]) && existing[k].length);
    if (has && !force) {
      await ctx.release();
      console.error('\nDatabase đích ĐÃ CÓ dữ liệu — dừng để không ghi đè. Thêm --force nếu chắc chắn muốn thay thế toàn bộ.');
      process.exit(2);
    }
    await ctx.commit({ db: doc, dirty: true, uploads, deletes: new Set() });
    console.log('\nĐã chuyển xong.');
    process.exit(0);
  } catch (e) {
    await ctx.rollback().catch(() => {});
    console.error('Lỗi khi chuyển dữ liệu:', (e as Error).message);
    process.exit(1);
  }
})();
