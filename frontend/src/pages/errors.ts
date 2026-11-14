/**
 * Trang lỗi chung của frontend (404, 500, mất kết nối backend) — một khuôn duy nhất (views/error.hbs).
 *
 *  - `renderError(res, status, opts)`   dùng ở bất kỳ route nào cần báo lỗi bằng trang đầy đủ (layout + sidebar).
 *  - `registerErrorHandlers(app)`       gắn 404 + error middleware; gọi SAU KHI đăng ký mọi route.
 *
 * Lưu ý Express 4: lỗi ném trong handler ASYNC không tự vào error handler. Route async phải bọc try/catch rồi `next(err)`
 * (như `page()` trong index.ts) — nếu không sẽ thành unhandledRejection.
 *
 * Quy ước: lỗi do backend không trả lời -> 502 (retry = true); lỗi trong code frontend -> 500 (chỉ hiện chi tiết khi dev);
 * đường dẫn không tồn tại -> 404 (không có nút "Thử lại"). Chi tiết luôn được ghi log phía server.
 */
import type { Express, NextFunction, Request, Response } from 'express';

export interface ErrorPage {
  /** Tiêu đề lớn của trang. */
  heading: string;
  /** Thông điệp chính cho người dùng. */
  message: string;
  /** Gợi ý cách xử lý (không bắt buộc). */
  hint?: string;
  /** Hiện nút "Thử lại" (tải lại đúng trang này). Mặc định true. */
  retry?: boolean;
}

/** Đang chạy production (Vercel hoặc NODE_ENV=production): không lộ chi tiết lỗi nội bộ ra trang. */
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

/** Trả trang lỗi đầy đủ giao diện với mã HTTP `status`. */
export function renderError(res: Response, status: number, page: ErrorPage): void {
  res.status(status).render('error', { tab: '', title: page.heading, status, retry: page.retry !== false, ...page });
}

/** Gắn xử lý 404 và lỗi bất ngờ. Phải đặt sau mọi route khác. */
export function registerErrorHandlers(app: Express): void {
  app.use((req: Request, res: Response) => {
    renderError(res, 404, {
      heading: 'Không tìm thấy trang',
      message: 'Đường dẫn này không tồn tại hoặc dữ liệu đã bị xóa.',
      hint: 'Kiểm tra lại đường dẫn, hoặc quay về trang tổng quan.',
      retry: false,
    });
  });

  // Lỗi bất ngờ (code frontend ném lỗi, template lỗi...). 4 tham số là bắt buộc để Express nhận ra đây là error handler.
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(`[frontend] lỗi khi xử lý ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return next(err);
    renderError(res, 500, {
      heading: 'Có lỗi xảy ra',
      message: 'Trang không hiển thị được do lỗi hệ thống. Bạn thử tải lại sau ít phút.',
      hint: IS_PROD ? 'Nếu lỗi lặp lại, hãy báo cho quản trị viên.' : `Chi tiết (chỉ hiện khi chạy dev): ${err.message}`,
    });
  });
}
