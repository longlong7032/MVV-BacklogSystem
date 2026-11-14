/**
 * Backlog (feedback lỗi) + tệp đính kèm + xuất Excel.
 *   GET    /api/feedbacks                 ?project=<idPublic>
 *   POST   /api/feedbacks                 multipart: project_id, team_id, assignee_id, status, title, type, note_text,
 *                                          location_url, bug_text, expected_text, location_image, bug_images[], expected_images[], har_file
 *   PUT    /api/feedbacks/:id             (như POST) + remove_location_image, remove_bug_images (JSON), remove_expected_images (JSON), remove_har
 *   PATCH  /api/feedbacks/:id/status      { status }
 *   PATCH  /api/feedbacks/:id/team        { team_id }
 *   DELETE /api/feedbacks/:id             xóa mềm
 *   GET    /api/export                    ?project&team&type&status&q  -> file .xlsx
 */
import { Router } from 'express';
import type { Request } from 'express';
import ExcelJS from 'exceljs';
import { q, q1 } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { bad, iso, isoReq, notFound, route, sameName, str, uuidParam } from '../lib/http.js';
import { fileUrl, softDeleteFiles } from '../lib/blobs.js';
import { HAR_FIELD, saveUploaded, uploadFields } from '../lib/upload.js';
import { recordActivity } from './activity.js';
import type { Feedback, FeedbackStatus } from '../types.js';

const STATUSES: FeedbackStatus[] = ['todo', 'doing', 'done'];
export const STATUS_LABELS: Record<FeedbackStatus, string> = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Đã hoàn thành' };
const isStatus = (v: string): v is FeedbackStatus => (STATUSES as string[]).includes(v);

/* ---------- Đọc ---------- */

const SELECT = `
  SELECT f.*, p.id_public AS project_pid, p.name AS project_name, p.code AS project_code,
         t.id_public AS team_pid, t.name AS team_name, u.id_public AS assignee_pid, u.name AS assignee_name
  FROM feedbacks f
  JOIN projects p ON p.id_private = f.project_id
  LEFT JOIN teams t ON t.id_private = f.team_id AND t.deleted_at IS NULL
  LEFT JOIN users u ON u.id_private = f.assignee_id AND u.deleted_at IS NULL AND u.active`;

/** Dựng DTO cho các dòng backlog (đã JOIN theo SELECT), kèm ảnh / HAR. */
export async function toFeedbacks(rows: Record<string, any>[]): Promise<Feedback[]> {
  const ids = rows.map((r) => r.id_private);
  const files = ids.length
    ? await q(
        `SELECT a.feedback_id, a.kind, fl.storage_key, fl.original_name, fl.size
         FROM feedback_attachments a JOIN files fl ON fl.id_private = a.file_id
         WHERE a.deleted_at IS NULL AND fl.deleted_at IS NULL AND a.feedback_id = ANY($1) ORDER BY a.sort_order, a.id_private`,
        [ids]
      )
    : [];
  return rows.map((r) => {
    const mine = files.filter((x) => x.feedback_id === r.id_private);
    const urls = (kind: string): string[] => mine.filter((x) => x.kind === kind).map((x) => fileUrl(x.storage_key));
    const har = mine.find((x) => x.kind === 'har');
    return {
      idPublic: r.id_public,
      createdAt: isoReq(r.created_at),
      updatedAt: isoReq(r.updated_at),
      projectId: r.project_pid,
      teamId: r.team_pid || '',
      assigneeId: r.assignee_pid || '',
      stt: r.stt,
      title: r.title,
      type: r.type,
      note: r.note,
      status: r.status,
      location: { url: r.location_url, image: urls('location')[0] || '' },
      bug: { text: r.bug_text, images: urls('bug') },
      expected: { text: r.expected_text, images: urls('expected') },
      har: har ? { url: fileUrl(har.storage_key), name: har.original_name || 'network.har', size: har.size } : null,
      completedAt: iso(r.completed_at),
      updatedBy: r.updated_by,
    };
  });
}

/** Danh sách backlog còn hiệu lực (lọc theo dự án nếu có). */
export async function listFeedbacks(projectPublicId = ''): Promise<Feedback[]> {
  const rows = await q(
    `${SELECT} WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.id_public = $1::uuid) ORDER BY p.name, f.stt`,
    [projectPublicId || null]
  );
  return toFeedbacks(rows);
}

export async function loadFeedback(id: number): Promise<Feedback> {
  return (await toFeedbacks(await q(`${SELECT} WHERE f.id_private = $1`, [id])))[0]!;
}

/* ---------- Ghi ---------- */

/** STT kế tiếp trong dự án (khóa dòng dự án để hai request đồng thời không lấy trùng số). */
async function nextStt(projectId: number): Promise<number> {
  await q('SELECT 1 FROM projects WHERE id_private = $1 FOR UPDATE', [projectId]);
  const row = await q1<{ n: number }>('SELECT COALESCE(MAX(stt), 0) + 1 AS n FROM feedbacks WHERE project_id = $1', [projectId]);
  return row!.n;
}

/** Tạo backlog "xuất hóa đơn công ty" (dùng cho đợt thanh toán / dự án). Trả về id nội bộ. */
export async function createInvoiceTask(projectId: number, title: string, note: string, actor: string): Promise<number> {
  const stt = await nextStt(projectId);
  const publicId = uuidv7();
  const row = await q1(
    `INSERT INTO feedbacks (id_public, project_id, stt, title, type, note, bug_text) VALUES ($1, $2, $3, $4, 'Hóa đơn', $5, $6) RETURNING id_private`,
    [publicId, projectId, stt, title, note, 'Xuất hóa đơn công ty cho khoản thanh toán đã ghi nhận.']
  );
  await recordActivity({ projectId, entityType: 'backlog', entityPublicId: publicId, entityTitle: title, action: 'created', actor, details: ['Tạo công việc xuất hóa đơn'] });
  return row!.id_private;
}

/** Thêm tệp đính kèm cho backlog. */
async function attach(feedbackId: number, kind: string, fileIds: number[]): Promise<void> {
  const base = (await q1<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM feedback_attachments WHERE feedback_id = $1', [feedbackId]))!.n;
  for (const [i, fileId] of fileIds.entries()) {
    await q('INSERT INTO feedback_attachments (id_public, feedback_id, file_id, kind, sort_order) VALUES ($1, $2, $3, $4, $5)', [uuidv7(), feedbackId, fileId, kind, base + i]);
  }
}

/** Xóa mềm tệp đính kèm theo loại (và danh sách URL nếu có). */
async function detach(feedbackId: number, kind: string, urls?: string[]): Promise<void> {
  const rows = await q<{ id_private: number; file_id: number }>(
    `UPDATE feedback_attachments a SET deleted_at = now() FROM files fl
     WHERE a.file_id = fl.id_private AND a.feedback_id = $1 AND a.kind = $2 AND a.deleted_at IS NULL
       AND ($3::text[] IS NULL OR fl.storage_key = ANY($3))
     RETURNING a.id_private, a.file_id`,
    [feedbackId, kind, urls ? urls.map((u) => u.replace(/^\/uploads\//, '')) : null]
  );
  await softDeleteFiles(rows.map((r) => r.file_id));
}

/** Parse chuỗi JSON thành mảng chuỗi; sai định dạng -> mảng rỗng. */
function parseList(value: unknown): string[] {
  try {
    const list: unknown = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Đọc + kiểm tra các trường chung của form backlog. */
async function readForm(req: Request, fallbackStatus: FeedbackStatus) {
  const b = req.body || {};
  const projectId = (await privateId('projects', str(b.project_id))) ?? bad('Vui lòng chọn dự án.');
  const status = str(b.status) || fallbackStatus;
  if (!isStatus(status)) bad('Trạng thái không hợp lệ.');
  const teamPublic = str(b.team_id);
  const teamId = teamPublic ? ((await privateId('teams', teamPublic)) ?? bad('Team không tồn tại.')) : null;
  const assigneePublic = str(b.assignee_id);
  let assigneeId: number | null = null;
  if (assigneePublic) {
    const u = await q1<{ id_private: number }>('SELECT id_private FROM users WHERE id_public::text = $1 AND deleted_at IS NULL AND active', [assigneePublic]);
    assigneeId = u?.id_private ?? bad('Người xử lý không tồn tại hoặc đã bị vô hiệu hóa.');
  }
  const title = str(b.title);
  const type = str(b.type);
  if (title.length > 200) bad('Tên lỗi tối đa 200 ký tự.');
  if (type.length > 60) bad('Loại tối đa 60 ký tự.');
  return {
    projectId: projectId as number,
    status: status as FeedbackStatus,
    teamId,
    assigneeId,
    title,
    type,
    note: str(b.note_text),
    locationUrl: str(b.location_url),
    bugText: str(b.bug_text),
    expectedText: str(b.expected_text),
  };
}

/** Lưu ảnh / HAR vừa tải lên và gắn vào backlog. */
async function saveAttachments(req: Request, feedbackId: number): Promise<void> {
  for (const [field, kind] of [['location_image', 'location'], ['bug_images', 'bug'], ['expected_images', 'expected'], [HAR_FIELD, 'har']] as const) {
    const saved = await saveUploaded(req, field);
    if (saved.length) await attach(feedbackId, kind, saved.map((s) => s.idPrivate));
  }
}

/** Đổi trạng thái (dùng chung cho API và MCP). */
export async function setFeedbackStatus(publicId: string, status: FeedbackStatus, actor: string, viaMcp = false): Promise<Feedback> {
  if (!isStatus(status)) bad('Trạng thái không hợp lệ.');
  const id = (await privateId('feedbacks', publicId, true)) ?? notFound('Không tìm thấy backlog.');
  const before = (await q1('SELECT status, title, stt, project_id FROM feedbacks WHERE id_private = $1', [id]))!;
  if (before.status !== status) {
    await q(
      `UPDATE feedbacks SET status = $2, completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END${viaMcp ? ', updated_by = $3' : ''} WHERE id_private = $1`,
      viaMcp ? [id, status, actor] : [id, status]
    );
    await recordActivity({
      projectId: before.project_id, entityType: 'backlog', entityPublicId: publicId, entityTitle: before.title || `Backlog #${before.stt}`,
      action: 'status', actor, details: [`Trạng thái: ${STATUS_LABELS[before.status as FeedbackStatus]} → ${STATUS_LABELS[status]}`],
    });
  }
  return loadFeedback(id);
}

/** Giao team (dùng chung cho API và MCP); teamPublicId '' = bỏ phân công. */
export async function assignFeedbackTeam(publicId: string, teamPublicId: string, actor: string, viaMcp = false): Promise<Feedback> {
  const id = (await privateId('feedbacks', publicId, true)) ?? notFound('Không tìm thấy backlog.');
  const teamId = teamPublicId ? ((await privateId('teams', teamPublicId)) ?? bad('Team không tồn tại.')) : null;
  const before = (await q1('SELECT team_id, title, stt, project_id FROM feedbacks WHERE id_private = $1', [id]))!;
  if (before.team_id !== teamId) {
    await q(`UPDATE feedbacks SET team_id = $2${viaMcp ? ', updated_by = $3' : ''} WHERE id_private = $1`, viaMcp ? [id, teamId, actor] : [id, teamId]);
    const teamName = teamId ? (await q1('SELECT name FROM teams WHERE id_private = $1', [teamId]))!.name : 'Chưa phân công';
    await recordActivity({
      projectId: before.project_id, entityType: 'backlog', entityPublicId: publicId, entityTitle: before.title || `Backlog #${before.stt}`,
      action: 'assigned', actor, details: [`Giao team: ${teamName}`],
    });
  }
  return loadFeedback(id);
}

/* ---------- Routes ---------- */

export const feedbacksRouter = Router();

feedbacksRouter.get('/feedbacks', route(async (req, res) => void res.json(await listFeedbacks(uuidParam(req.query.project)))));

feedbacksRouter.post(
  '/feedbacks',
  uploadFields,
  route(async (req, res) => {
    const v = await readForm(req, 'todo');
    const publicId = uuidv7();
    const row = await q1(
      `INSERT INTO feedbacks (id_public, project_id, team_id, assignee_id, stt, title, type, note, status, location_url, bug_text, expected_text, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $9 = 'done' THEN now() ELSE NULL END) RETURNING id_private, stt`,
      [publicId, v.projectId, v.teamId, v.assigneeId, await nextStt(v.projectId), v.title, v.type, v.note, v.status, v.locationUrl, v.bugText, v.expectedText]
    );
    await saveAttachments(req, row!.id_private);
    await recordActivity({ projectId: v.projectId, entityType: 'backlog', entityPublicId: publicId, entityTitle: v.title || `Backlog #${row!.stt}`, action: 'created', actor: 'Thành viên', details: ['Tạo backlog'] });
    res.status(201).json(await loadFeedback(row!.id_private));
  })
);

feedbacksRouter.put(
  '/feedbacks/:id',
  uploadFields,
  route(async (req, res) => {
    const id = (await privateId('feedbacks', req.params.id as string, true)) ?? notFound('Không tìm thấy backlog.');
    const before = (await q1('SELECT * FROM feedbacks WHERE id_private = $1', [id]))!;
    const v = await readForm(req, before.status);
    const b = req.body || {};
    // Đổi dự án -> cấp lại STT trong dự án mới
    const stt = v.projectId !== before.project_id ? await nextStt(v.projectId) : before.stt;
    await q(
      `UPDATE feedbacks SET project_id = $2, stt = $3, team_id = $4, assignee_id = $5, title = $6, type = $7, note = $8, status = $9,
         location_url = $10, bug_text = $11, expected_text = $12,
         completed_at = CASE WHEN $9 = 'done' THEN COALESCE(CASE WHEN status = 'done' THEN completed_at END, now()) ELSE NULL END
       WHERE id_private = $1`,
      [id, v.projectId, stt, v.teamId, v.assigneeId, v.title, v.type, v.note, v.status, v.locationUrl, v.bugText, v.expectedText]
    );
    // Tệp đính kèm: thay ảnh vị trí / HAR, xóa ảnh được chọn, thêm ảnh mới
    if (b.remove_location_image === '1' || req.files && (req.files as Record<string, unknown[]>).location_image?.length) await detach(id, 'location');
    if (b.remove_har === '1' || req.files && (req.files as Record<string, unknown[]>)[HAR_FIELD]?.length) await detach(id, 'har');
    const removeBug = parseList(b.remove_bug_images);
    const removeExpected = parseList(b.remove_expected_images);
    if (removeBug.length) await detach(id, 'bug', removeBug);
    if (removeExpected.length) await detach(id, 'expected', removeExpected);
    await saveAttachments(req, id);

    const details: string[] = [];
    if (before.title !== v.title) details.push('Đổi tên công việc');
    if (before.type !== v.type) details.push('Đổi loại');
    if (before.status !== v.status) details.push(`Trạng thái: ${STATUS_LABELS[before.status as FeedbackStatus]} → ${STATUS_LABELS[v.status]}`);
    if (before.team_id !== v.teamId) details.push('Thay đổi team xử lý');
    if (before.assignee_id !== v.assigneeId) details.push(`Người xử lý: ${v.assigneeId ? (await q1('SELECT name FROM users WHERE id_private = $1', [v.assigneeId]))!.name : 'Chưa giao'}`);
    if (before.bug_text !== v.bugText) details.push('Sửa mô tả');
    if (before.expected_text !== v.expectedText) details.push('Sửa kết quả mong muốn');
    if (before.note !== v.note) details.push('Sửa ghi chú');
    if (before.project_id !== v.projectId) details.push('Chuyển dự án');
    await recordActivity({
      projectId: v.projectId, entityType: 'backlog', entityPublicId: before.id_public, entityTitle: v.title || `Backlog #${stt}`,
      action: 'updated', actor: 'Thành viên', details: details.length ? details : ['Cập nhật nội dung hoặc tệp đính kèm'],
    });
    res.json(await loadFeedback(id));
  })
);

feedbacksRouter.patch(
  '/feedbacks/:id/status',
  route(async (req, res) => void res.json(await setFeedbackStatus(req.params.id as string, str((req.body || {}).status) as FeedbackStatus, 'Thành viên')))
);

feedbacksRouter.patch(
  '/feedbacks/:id/team',
  route(async (req, res) => void res.json(await assignFeedbackTeam(req.params.id as string, str((req.body || {}).team_id), 'Thành viên')))
);

feedbacksRouter.delete(
  '/feedbacks/:id',
  route(async (req, res) => {
    const id = (await privateId('feedbacks', req.params.id as string, true)) ?? notFound('Không tìm thấy backlog.');
    const row = (await q1('UPDATE feedbacks SET deleted_at = now() WHERE id_private = $1 RETURNING id_public, title, stt, project_id', [id]))!;
    await q('UPDATE feedback_attachments SET deleted_at = now() WHERE feedback_id = $1 AND deleted_at IS NULL', [id]);
    await recordActivity({ projectId: row.project_id, entityType: 'backlog', entityPublicId: row.id_public, entityTitle: row.title || `Backlog #${row.stt}`, action: 'deleted', actor: 'Thành viên', details: ['Xóa backlog'] });
    res.json({ ok: true });
  })
);

/* ---------- Xuất Excel (cùng bộ lọc như giao diện) ---------- */

feedbacksRouter.get(
  '/export',
  route(async (req, res) => {
    const project = uuidParam(req.query.project);
    const teamFilter = str(req.query.team);
    const typeFilter = str(req.query.type);
    const status = str(req.query.status);
    const needle = str(req.query.q).toLowerCase();
    const base = req.protocol + '://' + req.get('host');
    const abs = (u: string): string => (u ? base + u : '');
    const rows = await q(`${SELECT} WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.id_public = $1::uuid) ORDER BY p.name, f.stt`, [project || null]);
    const meta = new Map(rows.map((r) => [r.id_public, r]));
    const list = (await toFeedbacks(rows))
      .filter((f) => !status || f.status === status)
      .filter((f) => !teamFilter || (teamFilter === 'none' ? !f.teamId : f.teamId === teamFilter))
      .filter((f) => !typeFilter || (typeFilter === 'none' ? !f.type : sameName(f.type, typeFilter)))
      .filter((f) => {
        const m = meta.get(f.idPublic)!;
        return !needle || [m.project_code, m.project_name, f.type, f.title, f.location.url, f.bug.text, f.expected.text, f.note].some((s) => String(s || '').toLowerCase().includes(needle));
      });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Backlog', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Mã dự án', key: 'code', width: 12 },
      { header: 'Tên dự án', key: 'project', width: 22 },
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Loại', key: 'type', width: 18 },
      { header: 'Team xử lý', key: 'team', width: 20 },
      { header: 'Người xử lý', key: 'assignee', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 16 },
      { header: 'Tên lỗi', key: 'title', width: 34 },
      { header: 'Vị trí lỗi (URL)', key: 'url', width: 36 },
      { header: 'Ảnh vị trí lỗi', key: 'locImg', width: 30 },
      { header: 'Mô tả lỗi', key: 'bug', width: 50 },
      { header: 'Ảnh mô tả lỗi', key: 'bugImgs', width: 30 },
      { header: 'Kết quả mong muốn', key: 'expected', width: 50 },
      { header: 'Ảnh kết quả mong muốn', key: 'expImgs', width: 30 },
      { header: 'Ghi chú', key: 'note', width: 36 },
      { header: 'File HAR', key: 'har', width: 30 },
      { header: 'Ngày tạo', key: 'createdAt', width: 18 },
      { header: 'Ngày hoàn thành', key: 'completedAt', width: 18 },
    ];
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    for (const f of list) {
      const m = meta.get(f.idPublic)!;
      ws.addRow({
        code: m.project_code, project: m.project_name, stt: f.stt, type: f.type, team: m.team_name || '', assignee: m.assignee_name || '',
        status: STATUS_LABELS[f.status], title: f.title, url: f.location.url, locImg: abs(f.location.image),
        bug: f.bug.text, bugImgs: f.bug.images.map(abs).join('\n'), expected: f.expected.text, expImgs: f.expected.images.map(abs).join('\n'),
        note: f.note, har: f.har ? abs(f.har.url) : '', createdAt: new Date(f.createdAt), completedAt: f.completedAt ? new Date(f.completedAt) : null,
      });
    }
    ws.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });
    ws.getColumn('createdAt').numFmt = 'dd/mm/yyyy hh:mm';
    ws.getColumn('completedAt').numFmt = 'dd/mm/yyyy hh:mm';
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="backlog-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  })
);
