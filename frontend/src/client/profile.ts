/** Trang Hồ sơ: đổi tên hiển thị và đổi mật khẩu (đăng xuất do users.ts xử lý qua [data-logout]). */
import { api, jsonBody } from './api.js';
import { $, errorMessage, maybe, setError, showToast } from './dom.js';
import type { Field } from './dom.js';

/** Gắn hành vi trang Hồ sơ (nếu trang có form tương ứng). */
export function initProfile(): void {
  const profileForm = maybe<HTMLFormElement>('#profileForm');
  const passwordForm = maybe<HTMLFormElement>('#passwordForm');

  profileForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('[data-error]', profileForm);
    const submit = $<HTMLButtonElement>('[data-submit]', profileForm);
    const name = ($<Field>('[name=name]', profileForm).value || '').trim();
    setError(errorBox, '');
    if (!name) return setError(errorBox, 'Vui lòng nhập tên hiển thị.');
    submit.disabled = true;
    try {
      await api('/api/admin/me', jsonBody('PUT', { name }));
      document.querySelectorAll('[data-profile-name]').forEach((el) => (el.textContent = name));
      showToast('Đã lưu hồ sơ.');
    } catch (err) {
      setError(errorBox, errorMessage(err));
    } finally {
      submit.disabled = false;
    }
  });

  passwordForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('[data-error]', passwordForm);
    const submit = $<HTMLButtonElement>('[data-submit]', passwordForm);
    const value = (n: string): string => maybe<Field>(`[name=${n}]`, passwordForm)?.value ?? '';
    const [current, next, confirm] = [value('current'), value('next'), value('confirm')];
    setError(errorBox, '');
    if (maybe('[name=current]', passwordForm) && !current) return setError(errorBox, 'Vui lòng nhập mật khẩu hiện tại.');
    if (next.length < 8) return setError(errorBox, 'Mật khẩu mới tối thiểu 8 ký tự.');
    if (next !== confirm) return setError(errorBox, 'Mật khẩu nhập lại không khớp.');
    submit.disabled = true;
    try {
      await api('/api/admin/password', jsonBody('POST', { current, next }));
      passwordForm.reset();
      showToast('Đã đổi mật khẩu.');
    } catch (err) {
      setError(errorBox, errorMessage(err));
    } finally {
      submit.disabled = false;
    }
  });
}
