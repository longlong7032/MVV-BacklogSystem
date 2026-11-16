/**
 * Tab Nhân sự của dự án: admin cấp / cấp lại / thu hồi token MCP theo dự án cho từng nhân sự.
 * Token chỉ hiện một lần trong hộp #projectTokenModal.
 */
import { api } from './api.js';
import { $, closest, data, maybe, openModal } from './dom.js';
import { confirmDialog } from './dialog.js';
import { reportError } from './errors.js';

export function initProjectTokens(): void {
  if (!maybe('#projectTokenModal')) return;

  $('[data-ptoken-done]').addEventListener('click', () => location.reload());

  document.addEventListener('click', async (e) => {
    const btn = closest(e, '[data-ptoken]');
    if (!btn) return;
    const url = `/api/projects/${encodeURIComponent(data(btn, 'project'))}/members/${encodeURIComponent(data(btn, 'user'))}/token`;
    const name = data(btn, 'name');
    try {
      if (data(btn, 'ptoken') === 'issue') {
        const reissue = data(btn, 'hasToken') === 'true';
        const ok = await confirmDialog({
          title: reissue ? `Cấp lại token cho "${name}"?` : `Cấp token cho "${name}"?`,
          message: reissue ? 'Token cũ của dự án này sẽ mất hiệu lực ngay.' : 'Token chỉ xem được backlog của dự án này và chỉ hiển thị một lần.',
          confirmLabel: reissue ? 'Cấp lại token' : 'Cấp token',
          danger: reissue,
        });
        if (!ok) return;
        const result = await api<{ token: string; user: { name: string }; project: { name: string } }>(url, { method: 'POST' });
        $('[data-ptoken-user]').textContent = result.user.name;
        $('[data-ptoken-project]').textContent = result.project.name;
        $('#ptokenValue').textContent = result.token;
        $('#ptokenCmd').textContent = `claude mcp add --transport http --scope user feedback-backlog ${location.origin}/mcp \\\n  --header "Authorization: Bearer ${result.token}"`;
        openModal($('#projectTokenModal'));
      } else {
        const ok = await confirmDialog({ title: `Thu hồi token dự án của "${name}"?`, message: 'Người này sẽ không kết nối MCP bằng token này được nữa.', confirmLabel: 'Thu hồi', danger: true });
        if (!ok) return;
        await api(url, { method: 'DELETE' });
        location.reload();
      }
    } catch (err) {
      await reportError(err);
    }
  });
}
