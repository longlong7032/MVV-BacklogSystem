/**
 * Tiện ích thao tác DOM dùng chung: truy vấn phần tử, modal, thông báo lỗi, toast, clipboard.
 * (HTML của trang do server render bằng Handlebars; code ở đây chỉ gắn hành vi.)
 */

/** Ô nhập liệu có `.value` (input, select hoặc textarea). */
export type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * Tìm một phần tử theo CSS selector; ném lỗi nếu không có.
 * @param T kiểu phần tử mong muốn, mặc định HTMLElement
 */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Không tìm thấy phần tử ${sel}`);
  return el;
};

/** Tìm phần tử theo selector; không có thì trả null (dùng cho phần tử chỉ có ở một số trang). */
export const maybe = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

/** Tìm tất cả phần tử khớp selector, trả về mảng thật (để dùng map/filter). */
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => [
  ...root.querySelectorAll<T>(sel),
];

/** Phần tử gần nhất (từ đích của sự kiện đi lên) khớp selector; không có -> null. */
export const closest = <T extends HTMLElement = HTMLElement>(e: Event, sel: string): T | null => {
  const target = e.target;
  return target instanceof Element ? target.closest<T>(sel) : null;
};

/** Đọc thuộc tính `data-*` của phần tử; thiếu -> chuỗi rỗng. */
export const data = (el: HTMLElement, key: string): string => el.dataset[key] ?? '';

/** Lấy thông điệp từ giá trị bắt được trong `catch` (kiểu `unknown`). */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Dữ liệu JSON mà server nhúng trong `data-item` của dòng/thẻ chứa `el`, đã parse. */
export const itemOf = <T>(el: HTMLElement): T | null => {
  const holder = el.closest<HTMLElement>('[data-item]');
  return holder ? (JSON.parse(holder.dataset.item ?? 'null') as T) : null;
};

/* ---------- Modal ---------- */

/*
 * Mọi modal dùng cấu trúc DaisyUI: `<div data-modal class="modal"><… class="modal-box">…</…></div>`.
 * Hiện / ẩn bằng class `modal-open` — chỉ thao tác qua 3 hàm dưới đây, không tự đổi class ở nơi khác.
 */

/** Modal có đang hiển thị không. */
export const isOpen = (el: HTMLElement): boolean => el.classList.contains('modal-open');

/** Mở modal và khóa cuộn trang. */
export const openModal = (el: HTMLElement): void => {
  el.classList.add('modal-open');
  document.body.classList.add('overflow-hidden');
};

/**
 * Đóng modal; bỏ khóa cuộn trang nếu không còn modal nào mở.
 * Phát sự kiện `modal:closed` để nơi sở hữu modal xử lý (vd tải lại trang).
 */
export const closeModal = (el: HTMLElement): void => {
  el.classList.remove('modal-open');
  if (!$$('[data-modal]').some(isOpen)) document.body.classList.remove('overflow-hidden');
  el.dispatchEvent(new CustomEvent('modal:closed'));
};

/** Hiện/ẩn thông báo lỗi trong một khung. */
export const setError = (el: HTMLElement | null, message?: string): void => {
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
};

/* ---------- Toast & clipboard ---------- */

/** Bộ đếm giờ tự tắt của toast (để hủy khi có toast mới). */
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Hiện thông báo nhỏ tự tắt sau 2,2 giây. */
export const showToast = (message: string): void => {
  const el = $('#toast');
  $('#toastMsg').textContent = message;
  el.classList.remove('hidden');
  el.classList.add('flex');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('flex');
  }, 2200);
};

/** Chép văn bản vào clipboard (có phương án dự phòng cho trình duyệt/HTTP không hỗ trợ). */
export const copyText = async (value: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // http / trình duyệt cũ không có clipboard API
    const ta = Object.assign(document.createElement('textarea'), { value });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
};
