/**
 * Tài liệu PTYC: form thêm / sửa, modal chi tiết (đổi trạng thái, tải phiên bản mới).
 * HTML do server render (documents-list.hbs + modal-document*.hbs); ở đây chỉ gắn hành vi rồi gọi API /api/documents.
 */
import { api, jsonBody } from './api.js';
import { $, $$, closest, closeModal, data, errorMessage, maybe, openModal, setError, showToast } from './dom.js';
import { alertDialog } from './dialog.js';
import { registerForm } from './crud.js';
import type { DocumentStatus, ProjectDocument } from '../types.js';

/** Form thêm / sửa tài liệu. */
function initForm(): void {
  const modal = maybe('#documentModal');
  const form = maybe<HTMLFormElement>('#documentForm');
  if (!modal || !form) return;
  const errorBox = $('[data-error]', form);
  const submit = $<HTMLButtonElement>('[data-submit]', form);
  const deleteBtn = $('[data-doc-delete]', form);
  const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string): T => form.elements.namedItem(name) as T;
  let editing: ProjectDocument | null = null;

  const open = (item: ProjectDocument | null): void => {
    editing = item;
    form.reset();
    setError(errorBox, '');
    $('[data-title]', form).textContent = item ? 'Sửa tài liệu' : 'Tải tài liệu PTYC';
    submit.textContent = item ? 'Lưu thay đổi' : 'Tải lên';
    $$('[data-create-only]', form).forEach((el) => el.classList.toggle('hidden', Boolean(item)));
    deleteBtn.classList.toggle('hidden', !item);
    deleteBtn.dataset.id = item?.idPublic ?? '';
    deleteBtn.dataset.label = item ? `tài liệu "${item.title}"` : '';
    deleteBtn.dataset.warn = 'Tài liệu và mọi phiên bản sẽ bị ẩn khỏi danh sách.';
    const project = field<HTMLSelectElement>('project_id');
    // Thêm mới: chọn sẵn dự án đang lọc / dự án của trang
    if (!item && !project.value && project.options.length === 2) project.selectedIndex = 1;
    if (item) {
      field<HTMLInputElement>('title').value = item.title;
      field<HTMLInputElement>('doc_type').value = item.docType;
      field<HTMLSelectElement>('status').value = item.status;
      field<HTMLTextAreaElement>('note').value = item.note;
    }
    openModal(modal);
    (item ? field<HTMLInputElement>('title') : project.value ? field<HTMLInputElement>('title') : project).focus();
  };
  registerForm('document', open);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(errorBox, '');
    if (!field<HTMLInputElement>('title').value.trim()) return setError(errorBox, 'Vui lòng nhập tên tài liệu.');
    if (!editing) {
      if (!field<HTMLSelectElement>('project_id').value) return setError(errorBox, 'Vui lòng chọn dự án.');
      if (!field<HTMLInputElement>('document_file').files?.length) return setError(errorBox, 'Vui lòng chọn file tài liệu.');
    }
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Đang lưu…';
    try {
      if (editing) {
        await api(`/api/documents/${editing.idPublic}`, jsonBody('PUT', {
          title: field<HTMLInputElement>('title').value,
          docType: field<HTMLInputElement>('doc_type').value,
          status: field<HTMLSelectElement>('status').value,
          note: field<HTMLTextAreaElement>('note').value,
        }));
      } else {
        await api('/api/documents', { method: 'POST', body: new FormData(form) });
      }
      closeModal(modal);
      location.reload();
    } catch (err) {
      setError(errorBox, errorMessage(err));
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
}

/** Modal chi tiết: nội dung lấy từ <template data-detail> của dòng; đổi trạng thái lưu ngay; tải phiên bản mới. */
function initDetail(): void {
  const modal = maybe('#documentDetailModal');
  const body = maybe('#documentDetailBody');
  const title = maybe('#documentDetailTitle');
  const versionForm = maybe<HTMLFormElement>('#documentVersionForm');
  if (!modal || !body || !title || !versionForm) return;
  const statusButtons = $$('[data-doc-status]', modal);
  const statusText = maybe('[data-doc-status-text]', modal);
  let holder: HTMLElement | null = null;
  let item: ProjectDocument | null = null;
  let changed = false;

  const markStatus = (status: string): void =>
    statusButtons.forEach((b) => {
      const on = data(b, 'docStatus') === status;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('btn-primary', on);
    });

  document.addEventListener('click', async (e) => {
    const opener = closest(e, '[data-doc-open]');
    if (opener) {
      holder = opener.closest<HTMLElement>('[data-item]');
      const tpl = holder?.querySelector<HTMLTemplateElement>('template[data-detail]');
      if (!holder || !tpl) return;
      item = JSON.parse(holder.dataset.item ?? 'null') as ProjectDocument | null;
      if (!item) return;
      body.replaceChildren(tpl.content.cloneNode(true));
      title.textContent = item.title;
      markStatus(item.status);
      if (statusText) statusText.textContent = 'Bấm để đổi, lưu ngay.';
      versionForm.reset();
      setError($('[data-error]', versionForm), '');
      openModal(modal);
      return;
    }
    const statusBtn = closest(e, '[data-doc-status]');
    if (statusBtn && item) {
      const prev = item.status;
      const next = data(statusBtn, 'docStatus') as DocumentStatus;
      if (next === prev) return;
      markStatus(next);
      if (statusText) statusText.textContent = 'Đang lưu…';
      try {
        item = await api<ProjectDocument>(`/api/documents/${item.idPublic}/status`, jsonBody('PATCH', { status: next }));
        changed = true;
        if (statusText) statusText.textContent = `Đã lưu: ${statusBtn.textContent?.trim()}`;
        showToast(`Đã chuyển sang "${statusBtn.textContent?.trim()}"`);
      } catch (err) {
        markStatus(prev);
        if (statusText) statusText.textContent = '';
        await alertDialog(errorMessage(err));
      }
      return;
    }
    if (closest(e, '[data-doc-edit]') && holder) {
      const target = holder;
      changed = false;
      closeModal(modal);
      target.querySelector<HTMLButtonElement>('[data-act="edit"]')?.click();
    }
  });

  versionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!item) return;
    const errorBox = $('[data-error]', versionForm);
    const submit = $<HTMLButtonElement>('[data-submit]', versionForm);
    setError(errorBox, '');
    if (!(versionForm.elements.namedItem('document_file') as HTMLInputElement).files?.length) return setError(errorBox, 'Vui lòng chọn file.');
    submit.disabled = true;
    submit.textContent = 'Đang tải lên…';
    try {
      await api(`/api/documents/${item.idPublic}/versions`, { method: 'POST', body: new FormData(versionForm) });
      location.reload();
    } catch (err) {
      setError(errorBox, errorMessage(err));
      submit.disabled = false;
      submit.textContent = 'Tải lên';
    }
  });

  modal.addEventListener('modal:closed', () => {
    if (changed) location.reload();
  });
}

/** Gắn hành vi trang tài liệu PTYC. */
export function initDocuments(): void {
  initForm();
  initDetail();
}
