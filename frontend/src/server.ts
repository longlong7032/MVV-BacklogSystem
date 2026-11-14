/**
 * Feedback backlog — FRONTEND: server Express render giao diện bằng Handlebars (views/*.hbs).
 *
 *  - Các trang (/dashboard, /backlog, ...) lấy dữ liệu từ BACKEND qua HTTP rồi render HTML.
 *  - Trình duyệt thêm / sửa / xóa dữ liệu bằng cách gọi `/api/...`; frontend chỉ proxy các đường dẫn
 *    `/api`, `/uploads`, `/mcp` sang backend (cùng origin nên cookie đăng nhập hoạt động, không cần CORS).
 *  - Frontend không chạm DB và không import code của backend: tách repo sau này chỉ cần copy thư mục này.
 *
 * Biến môi trường: PORT, BACKEND_URL, TRUST_PROXY, PUBLIC_URL (xem .env.example).
 */
import './lib/env.js'; // phải import đầu tiên để nạp .env trước khi các module khác đọc biến môi trường
import express from 'express';
import hbs from 'hbs';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_CONFIG_ERROR,
  BACKEND_URL,
  FRONTEND_MARK_HEADER,
  SELF_TARGET_ERROR,
  backendErrorFor,
  loadData,
  loadMcpInfo,
  loadUsers,
} from './backend.js';
import { ROOT_DIR } from './lib/paths.js';
import { registerPages } from './pages/index.js';
import { HELPERS } from './pages/util.js';

const { version } = createRequire(import.meta.url)(path.join(ROOT_DIR, 'package.json')) as { version: string };
const app = express();
const PORT = process.env.PORT || 4000;

// Số proxy tin cậy phía trước app (Vercel / nginx = 1). Không có proxy thì đặt TRUST_PROXY=0.
const trustProxy: number | string =
  process.env.TRUST_PROXY === undefined ? 1 : /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy);
app.disable('x-powered-by');

// Header bảo mật cơ bản cho mọi phản hồi
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/* ---------- Proxy sang backend ---------- */
// Chỉ đúng các tiền tố này (không dùng startsWith đơn giản vì `/mcp-guide` là trang của frontend)
const isBackendPath = (pathname: string): boolean => /^\/(api|uploads|mcp)(\/|$)/.test(pathname);

/** Trả lỗi JSON cho các đường dẫn proxy khi cấu hình backend sai. */
const sendConfigError = (res: express.Response, status: number, error: string): void => {
  res.status(status).json({ error, code: 'backend-config' });
};

// Chặn vòng lặp: request do chính frontend gửi đi (có FRONTEND_MARK_HEADER) mà lại quay về frontend
// => BACKEND_URL đang trỏ về frontend. Trả lỗi ngay thay vì proxy đệ quy.
app.use((req, res, next) => {
  if (req.headers[FRONTEND_MARK_HEADER]) return sendConfigError(res, 508, SELF_TARGET_ERROR);
  if (isBackendPath(req.path)) {
    const error = backendErrorFor(req);
    if (error) return sendConfigError(res, 503, error);
  }
  next();
});

// Đặt TRƯỚC mọi middleware đọc body để upload (multipart) và MCP được chuyển tiếp nguyên vẹn.
// Thiếu BACKEND_URL (production) thì không tạo proxy; middleware ở trên đã trả lỗi rõ ràng cho /api, /uploads, /mcp.
if (!BACKEND_CONFIG_ERROR) app.use(
  createProxyMiddleware({
    target: BACKEND_URL,
    pathFilter: isBackendPath,
    changeOrigin: true,
    xfwd: true, // thêm X-Forwarded-For/Proto/Host để backend biết IP và giao thức thật của người dùng
    proxyTimeout: 60_000,
    on: {
      proxyReq: (proxyReq) => proxyReq.setHeader(FRONTEND_MARK_HEADER, '1'),
      error: (err, req, res) => {
        console.error('[proxy] backend không phản hồi:', (err as Error).message);
        const r = res as import('node:http').ServerResponse;
        if (!r.headersSent) {
          r.statusCode = 502;
          r.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        r.end(JSON.stringify({ error: 'Không kết nối được backend, vui lòng thử lại sau.' }));
      },
    },
  })
);

/* ---------- View engine & file tĩnh ---------- */
app.set('view engine', 'hbs');
app.set('views', path.join(ROOT_DIR, 'views'));
// Partial dùng chung (views/partials/*.hbs) và helper định dạng (fmtDate, timeAgo, ...)
hbs.registerPartials(path.join(ROOT_DIR, 'views', 'partials'));
for (const [name, fn] of Object.entries(HELPERS)) hbs.registerHelper(name, fn);
// Production cache 10 phút; khi dev không cache để sửa JS (npm run build:client) là thấy ngay.
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
app.use('/public', express.static(path.join(ROOT_DIR, 'public'), IS_PROD ? { maxAge: '10m' } : { etag: true, maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

/* ---------- Các trang ---------- */
registerPages(app, { version, loadData, loadUsers, loadMcpInfo });

// Cấu hình backend sai: báo ngay khi khởi động (trên Vercel hiện trong Function Logs)
if (BACKEND_CONFIG_ERROR) console.error(`[frontend] ${BACKEND_CONFIG_ERROR}`);

// Lỗi bất ngờ chỉ được ghi log, không làm sập tiến trình
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

export default app;

// Chạy trực tiếp (npm start / npm run dev): mở cổng. Trên Vercel, api/index.js import app.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Cùng máy mà frontend và backend chung cổng => BACKEND_URL trỏ về chính frontend
  const backendPort = BACKEND_CONFIG_ERROR ? '' : new URL(BACKEND_URL).port;
  if (backendPort && backendPort === String(PORT) && /^(localhost|127\.0\.0\.1)$/.test(new URL(BACKEND_URL).hostname)) {
    console.error(`[frontend] ${SELF_TARGET_ERROR} (frontend PORT=${PORT}, BACKEND_URL=${BACKEND_URL})`);
  }
  app.listen(PORT, () => console.log(`Frontend chạy tại http://localhost:${PORT} (backend: ${BACKEND_URL || 'CHƯA CẤU HÌNH'})`));
}
