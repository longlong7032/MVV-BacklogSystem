/**
 * Hộp thoại xác nhận / thông báo dùng chung — thay cho confirm() và alert() của trình duyệt.
 * HTML nằm cuối layout.hbs (#dialogModal). Dùng:
 *   if (!(await confirmDialog({ title: 'Xóa dự án?', message: '…', confirmLabel: 'Xóa', danger: true }))) return;
 *   await alertDialog('Không lưu được, thử lại sau.');
 * Esc, nút Hủy, bấm ra ngoài hộp = hủy (trả false).
 */
import { $, closeModal, openModal } from './dom.js';

export interface ConfirmOptions {
  /** Câu hỏi ngắn, in đậm. */
  title: string;
  /** Giải thích thêm (xuống dòng được). */
  message?: string;
  /** Chữ trên nút đồng ý (mặc định "Đồng ý"). */
  confirmLabel?: string;
  /** Chữ trên nút hủy (mặc định "Hủy"). */
  cancelLabel?: string;
  /** Hành động nguy hiểm (xóa, thu hồi…): nút đỏ và mặc định focus vào "Hủy". */
  danger?: boolean;
}

/** Hàm trả lời của hộp thoại đang mở (null = không có). */
let settle: ((ok: boolean) => void) | null = null;

/** Gắn sự kiện cho hộp thoại (gọi một lần khi tải trang). */
export function initDialog(): void {
  const modal = $('#dialogModal');
  $('#dialogConfirm').addEventListener('click', () => {
    const done = settle;
    settle = null; // đặt trước khi đóng để sự kiện đóng không trả lời false
    closeModal(modal);
    done?.(true);
  });
  // Đóng bằng nút Hủy / Esc / bấm ra ngoài => hủy
  modal.addEventListener('modal:closed', () => {
    const done = settle;
    settle = null;
    done?.(false);
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
}

/** Hiện hộp thoại; trả về true nếu người dùng đồng ý. */
function show(o: ConfirmOptions, tone: 'ask' | 'danger' | 'error', alertOnly: boolean): Promise<boolean> {
  const modal = $('#dialogModal');
  settle?.(false); // hộp thoại trước đó (nếu còn) coi như hủy
  $('#dialogTitle').textContent = o.title;
  const message = $('#dialogMessage');
  message.textContent = o.message ?? '';
  message.classList.toggle('hidden', !o.message);

  const icon = $('#dialogIcon');
  icon.textContent = tone === 'ask' ? '?' : '!';
  icon.className = `flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-semibold ${tone === 'ask' ? 'bg-primary/15 text-primary' : tone === 'danger' ? 'bg-warning/20 text-warning' : 'bg-error/15 text-error'}`;

  const confirm = $('#dialogConfirm');
  confirm.textContent = o.confirmLabel ?? (alertOnly ? 'Đóng' : 'Đồng ý');
  confirm.className = `btn btn-sm ${tone === 'danger' ? 'btn-error' : 'btn-primary'}`;
  const cancel = $('#dialogCancel');
  cancel.textContent = o.cancelLabel ?? 'Hủy';
  cancel.classList.toggle('hidden', alertOnly);

  openModal(modal);
  (tone === 'danger' ? cancel : confirm).focus(); // hành động nguy hiểm: Enter không vô tình xác nhận
  return new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}

/** Hỏi xác nhận (có / không). */
export const confirmDialog = (o: ConfirmOptions): Promise<boolean> => show(o, o.danger ? 'danger' : 'ask', false);

/** Báo lỗi / thông báo một nút "Đóng". */
export const alertDialog = (message: string, title = 'Có lỗi xảy ra'): Promise<void> => show({ title, message, confirmLabel: 'Đóng' }, 'error', true).then(() => undefined);
