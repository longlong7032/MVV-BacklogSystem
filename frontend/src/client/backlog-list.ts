/**
 * Danh sách backlog: modal chi tiết (xem đầy đủ + đổi trạng thái nhanh)
 * và kéo thả thẻ Kanban để đổi trạng thái. Bảng chỉ để xem; sửa toàn bộ qua form backlog.
 */
import { api, jsonBody } from './api.js';
import { $$, closest, data, errorMessage, maybe, openModal, closeModal, showToast } from './dom.js';
import { alertDialog } from './dialog.js';
import type { Feedback } from '../types.js';

/** Gọi PATCH cho một backlog. */
const patchStatus = (id: string, status: string): Promise<Feedback> =>
  api<Feedback>(`/api/feedbacks/${id}/status`, jsonBody('PATCH', { status }));

/** Kéo thả Kanban: PATCH rồi tải lại; lỗi thì báo rồi vẫn tải lại để giao diện khớp server. */
async function patchAndReload(id: string, body: object): Promise<void> {
  try {
    await patchStatus(id, (body as { status: string }).status);
  } catch (err) {
    await alertDialog(errorMessage(err));
  }
  location.reload();
}

/**
 * Modal chi tiết: sao chép nội dung server đã render trong <template data-detail> của dòng / thẻ,
 * đánh dấu trạng thái hiện tại. Đổi trạng thái lưu ngay; đóng modal thì tải lại trang nếu có thay đổi.
 */
function initDetail(): void {
  const modal = maybe('#backlogDetailModal');
  const body = maybe('#backlogDetailBody');
  const title = maybe('#backlogDetailTitle');
  if (!modal || !body || !title) return;
  const statusButtons = $$('[data-quick-status]', modal);
  const statusText = maybe('[data-quick-status-text]', modal);

  let holder: HTMLElement | null = null; // dòng bảng / thẻ Kanban đang xem
  let item: Feedback | null = null;
  let changed = false;

  const markStatus = (status: string): void =>
    statusButtons.forEach((b) => {
      const on = data(b, 'quickStatus') === status;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('btn-primary', on);
    });

  const open = (from: HTMLElement): void => {
    holder = from.closest<HTMLElement>('[data-item]');
    const tpl = holder?.querySelector<HTMLTemplateElement>('template[data-detail]');
    if (!holder || !tpl) return;
    item = JSON.parse(holder.dataset.item ?? 'null') as Feedback | null;
    if (!item) return;
    body.replaceChildren(tpl.content.cloneNode(true));
    title.textContent = body.querySelector('[data-detail-title]')?.textContent?.trim() || 'Chi tiết backlog';
    markStatus(item.status);
    if (statusText) statusText.textContent = 'Bấm để đổi, lưu ngay.';
    openModal(modal);
  };

  /** Lưu trạng thái mới; lỗi thì trả lại trạng thái cũ. */
  const save = async (status: string, label: string, revert: () => void): Promise<void> => {
    if (!item) return;
    if (statusText) statusText.textContent = 'Đang lưu…';
    try {
      item = { ...item, ...(await patchStatus(item.idPublic, status)) };
      changed = true;
      if (statusText) statusText.textContent = `Đã lưu: ${label}`;
      showToast(`Đã cập nhật ${label.toLowerCase()}`);
    } catch (err) {
      revert();
      if (statusText) statusText.textContent = '';
      await alertDialog(errorMessage(err));
    }
  };

  document.addEventListener('click', (e) => {
    const opener = closest(e, '[data-detail-open]');
    if (opener) return open(opener);

    const statusBtn = closest(e, '[data-quick-status]');
    if (statusBtn && item) {
      const prev = item.status;
      const next = data(statusBtn, 'quickStatus');
      if (next === prev) return;
      markStatus(next);
      void save(next, `Trạng thái → ${statusBtn.textContent?.trim()}`, () => markStatus(prev));
      return;
    }
    // "Sửa": đóng chi tiết rồi mở form sửa của đúng backlog đó
    if (closest(e, '[data-detail-edit]') && holder) {
      const target = holder;
      changed = false; // form sửa tự tải lại trang khi lưu
      closeModal(modal);
      target.querySelector<HTMLButtonElement>('[data-act="edit"]')?.click();
    }
  });

  // Đóng modal: có thay đổi thì tải lại để danh sách khớp dữ liệu mới
  modal.addEventListener('modal:closed', () => {
    if (changed) location.reload();
  });
}

/** Gắn hành vi cho danh sách backlog. */
export function initBacklogList(): void {
  initDetail();

  // Kanban: kéo thẻ sang cột khác để đổi trạng thái
  const columns = $$('[data-col]');
  if (!columns.length) return;
  let dragId: string | null = null;
  const ring = ['ring-2', 'ring-primary/40'];

  document.addEventListener('dragstart', (e) => {
    const card = closest(e, '[data-card]');
    if (!card) return;
    dragId = data(card, 'card');
    e.dataTransfer?.setData('text/plain', dragId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    card.classList.add('opacity-50');
  });
  document.addEventListener('dragend', () => {
    dragId = null;
    $$('[data-card]').forEach((c) => c.classList.remove('opacity-50'));
    columns.forEach((c) => c.classList.remove(...ring));
  });
  document.addEventListener('dragover', (e) => {
    const col = closest(e, '[data-col]');
    if (!col || !dragId) return;
    e.preventDefault(); // cho phép thả vào cột
    columns.forEach((c) => ring.forEach((r) => c.classList.toggle(r, c === col)));
  });
  document.addEventListener('drop', (e) => {
    const col = closest(e, '[data-col]');
    if (!col || !dragId) return;
    e.preventDefault();
    void patchAndReload(dragId, { status: data(col, 'col') });
  });
}
