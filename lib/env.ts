// Nạp file .env (Node >= 20.12). Biến môi trường đã đặt sẵn (vd trên server) luôn được ưu tiên hơn file.
// ENV_FILE: chỉ định file cấu hình khác (vd khi chạy thử, để không nạp .env thật).
// Phải được import đầu tiên (ES module chạy import theo thứ tự) để các module sau đọc được biến môi trường.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(process.env.ENV_FILE || path.join(root, '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('Không đọc được .env:', e.message);
}
