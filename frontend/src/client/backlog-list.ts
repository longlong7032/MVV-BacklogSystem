/**
 * Thao tác nhanh trên danh sách backlog: đổi trạng thái / team ngay trên dòng, kéo thả thẻ Kanban.
 * Mỗi thao tác gọi API PATCH rồi tải lại trang để server render lại.
 */
import { api, jsonBody } from './api.js';
import { $$, closest, data, errorMessage } from './dom.js';
import type { Field } from './dom.js';

/** Gọi PATCH cho một backlog; lỗi thì báo rồi tải lại để giao diện khớp với server. */
async function patch(id: string, part: 'status' | 'team', body: object): Promise<void> {
  try {
    await api(`/api/feedbacks/${id}/${part}`, jsonBody('PATCH', body));
  } catch (err) {
    alert(errorMessage(err));
  }
  location.reload();
}

/** Gắn sự kiện cho dropdown trên dòng và kéo thả Kanban. */
export function initBacklogList(): void {
  // Dropdown trạng thái / team ở từng dòng
  document.addEventListener('change', (e) => {
    const status = closest<Field>(e, '[data-status-id]');
    if (status) return void patch(data(status, 'statusId'), 'status', { status: status.value });
    const team = closest<Field>(e, '[data-team-id]');
    if (team) void patch(data(team, 'teamId'), 'team', { team_id: team.value });
  });

  // Kanban: kéo thẻ sang cột khác để đổi trạng thái
  const columns = $$('[data-col]');
  if (!columns.length) return;
  let dragId: string | null = null;
  const ring = ['ring-2', 'ring-indigo-300'];

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
    void patch(dragId, 'status', { status: data(col, 'col') });
  });
}
