/**
 * Thêm / sửa / xóa dùng chung: form dự án và team (modal), nút "Thêm" / "Sửa" / "Xóa" trên các dòng.
 *
 * Quy ước: server render sẵn modal và gắn dữ liệu của từng dòng vào `data-item` (JSON);
 * code ở đây chỉ mở modal, điền giá trị, gọi API rồi tải lại trang để thấy dữ liệu mới.
 */
import { api, jsonBody } from './api.js';
import { $, closeModal, closest, data, errorMessage, itemOf, maybe, openModal, setError } from './dom.js';
import type { Field } from './dom.js';

/** Hàm mở một form (null = thêm mới, đối tượng = sửa). */
type Opener = (item: any) => void;

/** Các form đã đăng ký, theo tên: project, team, user, feedback. */
const openers = new Map<string, Opener>();

/** Đăng ký hàm mở form để nút `[data-open-form="..."]` và nút "Sửa" gọi tới. */
export const registerForm = (kind: string, open: Opener): void => {
  openers.set(kind, open);
};

/** Tên form tương ứng với từng trang (dùng cho nút "Sửa" trên dòng). */
const FORM_OF_TAB: Record<string, string> = { backlog: 'feedback', projects: 'project', teams: 'team', users: 'user' };

/** Mô tả một form đơn giản (một modal, gửi JSON tới `/api/<resource>`). */
export interface SimpleFormSpec<T extends { id: string }> {
  /** Id của modal. */
  modal: string;
  /** Id của form. */
  form: string;
  /** Tên tài nguyên trong URL API, vd "projects". */
  resource: string;
  /** Tiêu đề và nhãn nút khi thêm / khi sửa. */
  add: { title: string; submit: string };
  edit: { title: string; submit: string };
  /** Điền giá trị vào form (item = null là thêm mới). */
  fill(form: HTMLFormElement, item: T | null): void;
  /** Lấy dữ liệu gửi lên từ form; trả về chuỗi lỗi nếu chưa hợp lệ. */
  collect(form: HTMLFormElement, editing: T | null): object | string;
}

/** Điều khiển trả về từ `simpleForm`. */
export interface SimpleForm<T> {
  /**
   * Mở form.
   * @param item đối tượng cần sửa, hoặc null để thêm mới
   * @param onSaved thay cho việc tải lại trang: gọi với kết quả API sau khi lưu thành công
   */
  open(item: T | null, onSaved?: (result: any, editing: T | null) => void): void;
}

/**
 * Dựng điều khiển cho một form đơn giản và gắn sự kiện gửi form.
 * Sau khi lưu thành công: gọi `onSaved` nếu có, mặc định tải lại trang.
 */
export function simpleForm<T extends { id: string }>(spec: SimpleFormSpec<T>): SimpleForm<T> {
  const modal = $(`#${spec.modal}`);
  const form = $<HTMLFormElement>(`#${spec.form}`);
  const errorBox = $('[data-error]', form);
  const submitBtn = $<HTMLButtonElement>('[data-submit]', form);
  let editing: T | null = null;
  let after: ((result: any, editing: T | null) => void) | undefined;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(errorBox, '');
    const body = spec.collect(form, editing);
    if (typeof body === 'string') return setError(errorBox, body);

    const label = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Đang lưu...';
    try {
      const url = editing ? `/api/${spec.resource}/${editing.id}` : `/api/${spec.resource}`;
      const result = await api(url, jsonBody(editing ? 'PUT' : 'POST', body));
      const wasEditing = editing;
      closeModal(modal);
      if (after) after(result, wasEditing);
      else location.reload();
    } catch (err) {
      setError(errorBox, errorMessage(err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = label;
    }
  });

  return {
    open(item, onSaved) {
      editing = item;
      after = onSaved;
      form.reset();
      setError(errorBox, '');
      $('[data-title]', form).textContent = item ? spec.edit.title : spec.add.title;
      submitBtn.textContent = item ? spec.edit.submit : spec.add.submit;
      spec.fill(form, item);
      openModal(modal);
      form.querySelector<Field>('input:not([type=hidden]), select')?.focus();
    },
  };
}

/** Giá trị (đã cắt khoảng trắng) của ô có `name` trong form. */
export const field = (form: HTMLFormElement, name: string): string => (form.elements.namedItem(name) as Field).value.trim();

/** Gán giá trị cho ô có `name` trong form. */
export const setField = (form: HTMLFormElement, name: string, value: string): void => {
  (form.elements.namedItem(name) as Field).value = value;
};

/** Dữ liệu của dự án / team (đủ để điền form). */
interface Named {
  id: string;
  name: string;
  code?: string;
  lead?: string;
  description?: string;
}

/** Form dự án và form team (chỉ dựng khi trang có modal tương ứng). */
let projectForm: SimpleForm<Named> | null = null;

/** Mở form dự án; `onSaved` dùng khi mở từ form backlog (không tải lại trang). */
export const openProjectForm = (onSaved?: (project: any) => void): void => projectForm?.open(null, onSaved);

/** Gắn các form dự án / team và hành vi thêm / sửa / xóa trên trang. */
export function initCrud(): void {
  if (maybe('#projectModal')) {
    projectForm = simpleForm<Named>({
      modal: 'projectModal',
      form: 'projectForm',
      resource: 'projects',
      add: { title: 'Thêm dự án', submit: 'Lưu dự án' },
      edit: { title: 'Sửa dự án', submit: 'Lưu thay đổi' },
      fill: (form, p) => {
        setField(form, 'code', p?.code ?? '');
        setField(form, 'name', p?.name ?? '');
        setField(form, 'description', p?.description ?? '');
      },
      collect: (form) =>
        field(form, 'name')
          ? { code: field(form, 'code'), name: field(form, 'name'), description: field(form, 'description') }
          : 'Vui lòng nhập tên dự án.',
    });
    registerForm('project', (item) => projectForm?.open(item));
  }

  if (maybe('#teamModal')) {
    const teamForm = simpleForm<Named>({
      modal: 'teamModal',
      form: 'teamForm',
      resource: 'teams',
      add: { title: 'Thêm team', submit: 'Lưu team' },
      edit: { title: 'Sửa team', submit: 'Lưu thay đổi' },
      fill: (form, t) => {
        setField(form, 'name', t?.name ?? '');
        setField(form, 'lead', t?.lead ?? '');
        setField(form, 'description', t?.description ?? '');
      },
      collect: (form) =>
        field(form, 'name')
          ? { name: field(form, 'name'), lead: field(form, 'lead'), description: field(form, 'description') }
          : 'Vui lòng nhập tên team.',
    });
    registerForm('team', (item) => teamForm.open(item));
  }

  document.addEventListener('click', async (e) => {
    // Nút "Thêm ..." ở đầu trang
    const add = closest(e, '[data-open-form]');
    if (add) return openers.get(data(add, 'openForm'))?.(null);

    const act = closest(e, '[data-act]');
    if (!act) return;

    // Nút "Sửa" trên dòng / thẻ: mở form tương ứng với dữ liệu của dòng
    if (data(act, 'act') === 'edit') {
      const kind = FORM_OF_TAB[document.body.dataset.tab ?? ''];
      const item = itemOf(act);
      if (kind && item) openers.get(kind)?.(item);
      return;
    }

    // Nút "Xóa": hỏi xác nhận rồi gọi DELETE
    if (data(act, 'act') === 'delete') {
      const warn = data(act, 'warn');
      if (!confirm(`Xóa ${data(act, 'label')}?${warn ? `\n\n${warn}` : ''}`)) return;
      try {
        await api(`/api/${data(act, 'resource') || 'feedbacks'}/${data(act, 'id')}`, { method: 'DELETE' });
        location.reload();
      } catch (err) {
        alert(errorMessage(err));
      }
    }
  });
}
