/**
 * Trang Người dùng: đăng nhập / đăng xuất quản trị (cookie phiên do server đặt), form người dùng,
 * cấp / thu hồi token cá nhân và hộp hiển thị token (chỉ hiện một lần).
 */
import { api, jsonBody } from './api.js';
import { $, $$, closest, data, errorMessage, maybe, openModal, setError } from './dom.js';
import { alertDialog, confirmDialog } from './dialog.js';
import type { Field } from './dom.js';
import { field, registerForm, setField, simpleForm } from './crud.js';
import type { PublicUser } from '../types.js';

/** Hiện hộp token vừa cấp kèm lệnh kết nối Claude Code. */
function showToken(user: { name: string }, token: string): void {
  $('[data-token-user]').textContent = user.name;
  $('#tokenValue').textContent = token;
  $('#tokenCmd').textContent =
    `claude mcp add --transport http feedback-backlog ${location.origin}/mcp \\\n  --header "Authorization: Bearer ${token}"`;
  openModal($('#tokenModal'));
}

/** Gắn hành vi trang Người dùng (nếu trang có các phần tử tương ứng). */
export function initUsers(): void {
  initLogin();
  if (!maybe('#userModal')) return;

  // Form thêm / sửa người dùng
  const userForm = simpleForm<PublicUser>({
    modal: 'userModal',
    form: 'userForm',
    resource: 'users',
    add: { title: 'Thêm người dùng', submit: 'Lưu & tạo token' },
    edit: { title: 'Sửa người dùng', submit: 'Lưu thay đổi' },
    fill: (form, u) => {
      setField(form, 'name', u?.name ?? '');
      setField(form, 'email', u?.email ?? '');
      setField(form, 'role', u?.role ?? 'read');
      setField(form, 'teamId', u?.teamId ?? '');
      // Ô "đang hoạt động" chỉ có khi sửa; dòng ghi chú về token chỉ có khi thêm mới
      const active = form.elements.namedItem('active') as HTMLInputElement;
      active.checked = u ? u.active : true;
      const editOnly = $('[data-edit-only]', form);
      editOnly.classList.toggle('hidden', !u);
      editOnly.classList.toggle('flex', Boolean(u));
      $('[data-create-only]', form).classList.toggle('hidden', Boolean(u));
    },
    collect: (form, editing) => {
      if (!field(form, 'name')) return 'Vui lòng nhập họ tên.';
      if (!field(form, 'email')) return 'Vui lòng nhập email.';
      const body: Record<string, unknown> = {
        name: field(form, 'name'),
        email: field(form, 'email'),
        role: field(form, 'role'),
        teamId: field(form, 'teamId'),
      };
      if (editing) body.active = (form.elements.namedItem('active') as HTMLInputElement).checked;
      return body;
    },
  });
  registerForm('user', (item) =>
    userForm.open(item, (result, editing) => (editing ? location.reload() : showToken(result.user, result.token)))
  );

  // Hộp token: bắt buộc bấm xác nhận, rồi tải lại trang để thấy token mới trong bảng
  $('[data-token-done]').addEventListener('click', () => location.reload());

  // Cấp / cấp lại / thu hồi token
  document.addEventListener('click', async (e) => {
    const btn = closest(e, '[data-act="token"], [data-act="revoke"]');
    if (!btn) return;
    const id = data(btn, 'id');
    const name = data(btn, 'name');
    try {
      if (data(btn, 'act') === 'token') {
        const reissue = data(btn, 'hasToken') === 'true';
        const ok = await confirmDialog({
          title: reissue ? `Cấp lại token cho "${name}"?` : `Cấp token cho "${name}"?`,
          message: reissue ? 'Token cũ sẽ mất hiệu lực ngay lập tức.' : 'Token chỉ hiển thị một lần sau khi cấp.',
          confirmLabel: reissue ? 'Cấp lại token' : 'Cấp token',
          danger: reissue,
        });
        if (!ok) return;
        const result = await api(`/api/users/${id}/token`, { method: 'POST' });
        showToken(result.user, result.token);
      } else {
        const ok = await confirmDialog({ title: `Thu hồi token của "${name}"?`, message: 'Người này sẽ không kết nối MCP được nữa cho đến khi được cấp token mới.', confirmLabel: 'Thu hồi', danger: true });
        if (!ok) return;
        await api(`/api/users/${id}/token`, { method: 'DELETE' });
        location.reload();
      }
    } catch (err) {
      await alertDialog(errorMessage(err));
    }
  });
}

/** Form đăng nhập quản trị (hiện khi chưa đăng nhập) và nút Đăng xuất (hiện khi đã đăng nhập). */
function initLogin(): void {
  const form = maybe<HTMLFormElement>('[data-login]');
  if (form) {
    const passwordFields = $('#loginPasswordFields');
    const tokenFields = $('#loginTokenFields');
    const modeBtn = $('[data-login-mode]', form);
    const errorBox = $('[data-error]', form);
    const submit = $<HTMLButtonElement>('[data-submit]', form);
    let mode: 'password' | 'token' = 'password';

    // Chuyển giữa đăng nhập bằng mật khẩu và bằng token cá nhân
    modeBtn.addEventListener('click', () => {
      mode = mode === 'password' ? 'token' : 'password';
      passwordFields.classList.toggle('hidden', mode !== 'password');
      tokenFields.classList.toggle('hidden', mode !== 'token');
      modeBtn.textContent = mode === 'password' ? 'Đăng nhập bằng token cá nhân' : 'Đăng nhập bằng email và mật khẩu';
      setError(errorBox, '');
      $<Field>(mode === 'password' ? '#adminEmail' : '#adminKey').focus();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setError(errorBox, '');
      const body =
        mode === 'token'
          ? { token: $<Field>('#adminKey').value.trim() }
          : { email: $<Field>('#adminEmail').value.trim(), password: $<Field>('#adminPassword').value };
      if (mode === 'token' ? !('token' in body && body.token) : !('email' in body && body.email && body.password)) {
        return setError(errorBox, mode === 'token' ? 'Vui lòng dán token quản trị.' : 'Vui lòng nhập email và mật khẩu.');
      }
      submit.disabled = true;
      try {
        await api('/api/admin/login', jsonBody('POST', body)); // server đặt cookie phiên
        location.reload();
      } catch (err) {
        setError(errorBox, errorMessage(err));
        submit.disabled = false;
      }
    });
  }

  // Đăng xuất: hủy phiên trên server (xóa cookie) rồi tải lại
  $$('[data-logout]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api('/api/admin/session', { method: 'DELETE' }).catch(() => {});
      location.reload();
    })
  );
}
