/**
 * Xử lý lỗi toàn cục phía trình duyệt — MỘT chỗ duy nhất quyết định cách báo lỗi cho người dùng.
 *
 *  1. `initGlobalErrors()`  bắt mọi lỗi không ai xử lý (`error`, `unhandledrejection`) và mất / có lại mạng.
 *  2. `reportError(err, title?)`  dùng trong `catch` của các thao tác (xóa, lưu nhanh, tải lên…): hiện popup lỗi.
 *
 * Quy ước thông điệp:
 *  - `ApiError` (lỗi từ API): hiện đúng thông điệp tiếng Việt của nó.
 *  - Lỗi khác (bug JS, lỗi trình duyệt): hiện thông điệp chung — KHÔNG đưa chữ kỹ thuật ("Cannot read properties of null")
 *    cho người dùng; chi tiết đầy đủ nằm ở console.
 *  - Lỗi trong form (đang có ô báo lỗi riêng) vẫn dùng `setError()` tại chỗ như cũ, không qua đây.
 */
import { ApiError } from './api.js';
import { alertDialog, isDialogOpen } from './dialog.js';
import { showToast } from './dom.js';

/** Thông điệp chung cho lỗi không lường trước. */
const GENERIC = 'Ứng dụng gặp lỗi không mong muốn. Hãy tải lại trang rồi thử lại; nếu vẫn lỗi, báo cho quản trị viên.';

/** Thông điệp an toàn để hiện cho người dùng. */
export const userMessage = (err: unknown): string => (err instanceof ApiError ? err.message : GENERIC);

/** Lỗi trình duyệt vô hại, không đáng làm phiền người dùng. */
const IGNORED = [
  /ResizeObserver loop/i, // tiện ích / layout, không ảnh hưởng chức năng
  /^Script error\.?$/i, // lỗi từ script bên thứ ba (CDN) bị chặn chi tiết do khác origin
  /AbortError/i, // người dùng hủy / chuyển trang giữa chừng
];

/** Thông điệp đã hiện gần đây (chống bật lặp cùng một lỗi liên tục). */
const recent = new Map<string, number>();
const DEDUPE_MS = 5000;

/**
 * Báo lỗi cho người dùng bằng popup (hoặc toast nếu đang có popup khác).
 * Luôn ghi chi tiết ra console. Trả về khi người dùng đóng popup.
 */
export async function reportError(err: unknown, title = 'Có lỗi xảy ra'): Promise<void> {
  console.error('[lỗi]', err);
  const message = userMessage(err);
  const now = Date.now();
  for (const [key, at] of recent) if (now - at > DEDUPE_MS) recent.delete(key);
  if (recent.has(message)) return;
  recent.set(message, now);
  // Đang có popup khác (vd hỏi xác nhận): không chồng thêm, chỉ nhắc nhẹ bằng toast
  if (isDialogOpen()) return showToast(message);
  await alertDialog(message, title);
}

/** Gắn bộ bắt lỗi toàn cục (gọi một lần khi tải trang). */
export function initGlobalErrors(): void {
  window.addEventListener('error', (e) => {
    // Lỗi tải tài nguyên (ảnh hỏng...) không có e.error: chỉ ghi log, không làm phiền
    if (!(e.error instanceof Error) || IGNORED.some((re) => re.test(e.message))) return void console.warn('[bỏ qua]', e.message);
    void reportError(e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason;
    if (reason instanceof Error && IGNORED.some((re) => re.test(`${reason.name} ${reason.message}`))) return;
    e.preventDefault(); // đã xử lý ở đây, không in thêm "Uncaught (in promise)"
    void reportError(reason);
  });
  window.addEventListener('offline', () => showToast('Mất kết nối mạng — thay đổi có thể chưa được lưu.'));
  window.addEventListener('online', () => showToast('Đã kết nối lại mạng.'));
}
