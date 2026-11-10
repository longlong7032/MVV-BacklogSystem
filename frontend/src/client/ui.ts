/**
 * Hành vi giao diện chung cho mọi trang: sidebar di động, ẩn/hiện panel, tự gửi form lọc,
 * sao chép, xem ảnh lớn, đóng modal bằng nút / phím Esc, chuyển trang cũ dạng `#/...`.
 */
import { $, $$, closest, closeModal, copyText, data, isOpen, maybe } from './dom.js';

/** Đóng sidebar (giao diện di động). */
const closeSidebar = (): void => {
  $('#sidebar').classList.add('-translate-x-full');
  $('#sidebarBackdrop').classList.add('hidden');
};

/** Đổi chữ trên nút một lúc để báo "Đã chép". */
const flash = (btn: HTMLElement, text: string): void => {
  const label = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = label), 1500);
};

/** Xem ảnh phóng to. */
const openLightbox = (src: string): void => {
  $<HTMLImageElement>('#lightboxImg').src = src;
  $('#lightbox').classList.remove('hidden');
  $('#lightbox').classList.add('flex');
};

/** Đóng ảnh phóng to. */
const closeLightbox = (): void => {
  $('#lightbox').classList.add('hidden');
  $('#lightbox').classList.remove('flex');
  $<HTMLImageElement>('#lightboxImg').removeAttribute('src');
};

/** Link kiểu cũ `/#/backlog?team=x` (hash) -> đường dẫn thật `/backlog?team=x`. */
const redirectLegacyHash = (): void => {
  if (!location.hash.startsWith('#/')) return;
  const target = location.hash.slice(1).replace(/^\/mcp(\?|$)/, '/mcp-guide$1');
  location.replace(target);
};

/** Gắn mọi hành vi chung. */
export function initUi(): void {
  redirectLegacyHash();

  // Sidebar (di động)
  maybe('#btnMenu')?.addEventListener('click', () => {
    $('#sidebar').classList.remove('-translate-x-full');
    $('#sidebarBackdrop').classList.remove('hidden');
  });
  maybe('#sidebarBackdrop')?.addEventListener('click', closeSidebar);

  document.addEventListener('click', async (e) => {
    // Ẩn/hiện panel: <button data-toggle="#id">
    const toggle = closest(e, '[data-toggle]');
    if (toggle) {
      const panel = $(data(toggle, 'toggle'));
      const open = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !open);
      panel.classList.toggle('grid', open);
      toggle.setAttribute('aria-expanded', String(open));
      return;
    }

    // Sao chép: nội dung phần tử khác / prompt mẫu / mã của tab MCP đang chọn
    const copy = closest(e, '[data-copy-target], [data-copy-prompt], [data-copy-active-tab]');
    if (copy) {
      let value: string | null | undefined;
      if (copy.dataset.copyTarget) value = $(data(copy, 'copyTarget')).textContent;
      else if (copy.hasAttribute('data-copy-active-tab')) value = maybe('[data-mcp-code]:not(.hidden)')?.textContent;
      else value = copy.parentElement?.querySelector('[data-prompt]')?.textContent;
      await copyText(value ?? '');
      flash(copy, 'Đã chép ✓');
      return;
    }

    // Phóng to ảnh
    const img = closest(e, '[data-zoom]');
    if (img) return openLightbox(data(img, 'zoom'));
    if (closest(e, '#lightbox')) closeLightbox();

    // Nút đóng của modal: <button data-close> nằm trong <... data-modal>
    const closer = closest(e, '[data-close]');
    const modal = closer?.closest<HTMLElement>('[data-modal]');
    if (modal) closeModal(modal);
  });

  // Form lọc kiểu GET: đổi lựa chọn / xong nhập thì gửi lại để server render lại trang
  document.addEventListener('change', (e) => {
    const el = e.target as HTMLElement;
    const form = el.closest<HTMLFormElement>('form[data-autosubmit], #filterForm');
    if (!form) return;
    if (el.matches('select[data-autosubmit], form[data-autosubmit] input, #filterQuery')) form.requestSubmit();
  });

  // Esc: đóng ảnh phóng to, rồi tới modal trên cùng (trừ modal bắt buộc như hộp token)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isOpen($('#lightbox'))) return closeLightbox();
    const open = $$('[data-modal]').filter(isOpen);
    if (open.some((m) => m.hasAttribute('data-modal-sticky'))) return; // token chỉ hiện một lần
    const top = open[open.length - 1];
    if (top) closeModal(top);
  });
}
