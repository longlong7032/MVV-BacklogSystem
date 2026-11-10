// Nạp file .env (Node >= 20.12). Biến môi trường đã đặt sẵn (vd trên server) luôn được ưu tiên hơn file.
// ENV_FILE: chỉ định file cấu hình khác (vd khi chạy thử, để không nạp .env thật).
// Phải được import đầu tiên (ES module chạy import theo thứ tự) để các module sau đọc được biến môi trường.
import path from 'node:path';
import { ROOT_DIR } from './paths.js';

try {
  process.loadEnvFile(process.env.ENV_FILE || path.join(ROOT_DIR, '.env'));
} catch (e) {
  // Không có file .env là bình thường (vd trên Vercel dùng biến môi trường của dự án) -> bỏ qua im lặng
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Không đọc được .env:', (e as Error).message);
}
