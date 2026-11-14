/**
 * Dự án (kèm nhân sự tham gia và vai trò).
 *   GET    /api/projects
 *   GET    /api/projects/:id
 *   POST   /api/projects                   { code?, name, description?, totalValue?, startDate?, deadline?, memberIds?[], roles?[{name, description}] }
 *   PUT    /api/projects/:id               (như POST)
 *   DELETE /api/projects/:id               xóa mềm dự án + backlog + thanh toán + tài liệu
 *   POST   /api/projects/:id/invoice-task  tạo backlog "xuất hóa đơn tổng" cho các đợt đã thu qua tài khoản công ty
 */
import { Router } from 'express';
import { q, q1 } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { DATE_RE, HttpError, bad, isoReq, notFound, route, sameName, str } from '../lib/http.js';
import { createInvoiceTask, loadFeedback } from './feedbacks.js';
import type { Project, ProjectRole } from '../types.js';

/** Dựng DTO cho các dòng dự án (kèm memberIds, roles). */
async function toProjects(rows: Record<string, any>[]): Promise<Project[]> {
  const ids = rows.map((r) => r.id_private);
  const members = ids.length
    ? await q(
        `SELECT pm.project_id, u.id_public FROM project_members pm JOIN users u ON u.id_private = pm.user_id
         WHERE pm.deleted_at IS NULL AND u.deleted_at IS NULL AND u.active AND pm.project_id = ANY($1) ORDER BY pm.id_private`,
        [ids]
      )
    : [];
  const roles = ids.length
    ? await q('SELECT project_id, id_public, name, description FROM project_roles WHERE deleted_at IS NULL AND project_id = ANY($1) ORDER BY sort_order, id_private', [ids])
    : [];
  return rows.map((r) => ({
    idPublic: r.id_public,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    code: r.code,
    name: r.name,
    description: r.description,
    totalValue: r.total_value,
    startDate: r.start_date || '',
    deadline: r.deadline || '',
    memberIds: members.filter((m) => m.project_id === r.id_private).map((m) => m.id_public),
    roles: roles.filter((x) => x.project_id === r.id_private).map((x) => ({ idPublic: x.id_public, name: x.name, description: x.description })),
    invoiceFeedbackId: r.invoice_pid || '',
  }));
}

const SELECT = `SELECT p.*, f.id_public AS invoice_pid FROM projects p LEFT JOIN feedbacks f ON f.id_private = p.invoice_feedback_id`;

export async function listProjects(): Promise<Project[]> {
  return toProjects(await q(`${SELECT} WHERE p.deleted_at IS NULL ORDER BY p.name`));
}

async function loadProject(id: number): Promise<Project> {
  return (await toProjects(await q(`${SELECT} WHERE p.id_private = $1`, [id])))[0]!;
}

interface ProjectInput {
  name: string;
  code: string;
  description: string;
  totalValue: number;
  startDate: string | null;
  deadline: string | null;
  memberIds: number[];
  roles: ProjectRole[];
}

/** Kiểm tra dữ liệu dự án gửi lên. */
async function validate(body: Record<string, unknown>, selfId?: number): Promise<ProjectInput> {
  const name = str(body.name);
  if (!name) bad('Vui lòng nhập tên dự án.');
  if (name.length > 120) bad('Tên dự án tối đa 120 ký tự.');
  const others = await q<{ name: string; code: string }>('SELECT name, code FROM projects WHERE deleted_at IS NULL AND id_private <> $1', [selfId ?? 0]);
  if (others.some((p) => sameName(p.name, name))) bad(`Dự án "${name}" đã tồn tại.`);
  const code = str(body.code).toUpperCase();
  if (code.length > 30) bad('Mã dự án tối đa 30 ký tự.');
  if (code && others.some((p) => p.code === code)) bad(`Mã dự án "${code}" đã được dùng.`);
  const totalValue = Number(body.totalValue || 0);
  if (!Number.isSafeInteger(Math.round(totalValue)) || totalValue < 0) bad('Tổng giá trị dự án phải là số không âm.');
  const startDate = str(body.startDate);
  const deadline = str(body.deadline);
  if ((startDate && !DATE_RE.test(startDate)) || (deadline && !DATE_RE.test(deadline))) bad('Ngày dự án không hợp lệ.');
  if (startDate && deadline && deadline < startDate) bad('Deadline phải bằng hoặc sau ngày bắt đầu.');

  // Nhân sự: idPublic -> id nội bộ; phải là người dùng đang hoạt động
  const requested = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(str).filter(Boolean))];
  const found = requested.length
    ? await q<{ id_private: number }>('SELECT id_private FROM users WHERE id_public::text = ANY($1) AND deleted_at IS NULL AND active', [requested])
    : [];
  if (found.length !== requested.length) bad('Danh sách thành viên có người dùng không còn hoạt động.');

  // Vai trò: bỏ dòng trống, tên tối đa 60 ký tự (dùng làm "Loại" của backlog), không trùng tên
  const roles: ProjectRole[] = [];
  for (const r of (Array.isArray(body.roles) ? body.roles : []) as Array<Record<string, unknown>>) {
    const roleName = str(r?.name);
    const description = str(r?.description);
    if (!roleName && !description) continue;
    if (!roleName) bad('Vai trò có mô tả nhưng chưa nhập tên vai trò.');
    if (roleName.length > 60) bad(`Tên vai trò "${roleName.slice(0, 20)}…" tối đa 60 ký tự.`);
    if (description.length > 1000) bad('Mô tả vai trò tối đa 1000 ký tự.');
    if (roles.some((x) => sameName(x.name, roleName))) bad(`Vai trò "${roleName}" bị trùng.`);
    roles.push({ name: roleName, description });
  }
  if (roles.length > 30) bad('Tối đa 30 vai trò cho một dự án.');
  return { name, code, description: str(body.description), totalValue: Math.round(totalValue), startDate: startDate || null, deadline: deadline || null, memberIds: found.map((u) => u.id_private), roles };
}

/** Ghi lại danh sách nhân sự và vai trò (xóa mềm bản cũ, thêm bản mới). */
async function saveChildren(projectId: number, v: ProjectInput): Promise<void> {
  await q('UPDATE project_members SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL AND NOT (user_id = ANY($2))', [projectId, v.memberIds]);
  for (const userId of v.memberIds) {
    await q(
      `INSERT INTO project_members (id_public, project_id, user_id) SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = $2 AND user_id = $3 AND deleted_at IS NULL)`,
      [uuidv7(), projectId, userId]
    );
  }
  await q('UPDATE project_roles SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL', [projectId]);
  for (const [i, r] of v.roles.entries()) {
    await q('INSERT INTO project_roles (id_public, project_id, name, description, sort_order) VALUES ($1, $2, $3, $4, $5)', [uuidv7(), projectId, r.name, r.description, i]);
  }
}

export const projectsRouter = Router();

projectsRouter.get('/projects', route(async (req, res) => void res.json(await listProjects())));

projectsRouter.get(
  '/projects/:id',
  route(async (req, res) => {
    const id = (await privateId('projects', req.params.id as string)) ?? notFound('Không tìm thấy dự án.');
    res.json(await loadProject(id));
  })
);

projectsRouter.post(
  '/projects',
  route(async (req, res) => {
    const v = await validate(req.body || {});
    const row = await q1(
      `INSERT INTO projects (id_public, code, name, description, total_value, start_date, deadline) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id_private`,
      [uuidv7(), v.code, v.name, v.description, v.totalValue, v.startDate, v.deadline]
    );
    await saveChildren(row!.id_private, v);
    res.status(201).json(await loadProject(row!.id_private));
  })
);

projectsRouter.put(
  '/projects/:id',
  route(async (req, res) => {
    const id = (await privateId('projects', req.params.id as string, true)) ?? notFound('Không tìm thấy dự án.');
    const v = await validate(req.body || {}, id);
    await q('UPDATE projects SET code = $2, name = $3, description = $4, total_value = $5, start_date = $6, deadline = $7 WHERE id_private = $1', [
      id, v.code, v.name, v.description, v.totalValue, v.startDate, v.deadline,
    ]);
    await saveChildren(id, v);
    res.json(await loadProject(id));
  })
);

projectsRouter.delete(
  '/projects/:id',
  route(async (req, res) => {
    const id = (await privateId('projects', req.params.id as string, true)) ?? notFound('Không tìm thấy dự án.');
    await q('UPDATE projects SET deleted_at = now() WHERE id_private = $1', [id]);
    const removed = await q('UPDATE feedbacks SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL RETURNING id_private', [id]);
    await q('UPDATE feedback_attachments SET deleted_at = now() WHERE feedback_id = ANY($1) AND deleted_at IS NULL', [removed.map((r) => r.id_private)]);
    await q('UPDATE payment_rounds SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL', [id]);
    const docs = await q('UPDATE documents SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL RETURNING id_private', [id]);
    await q('UPDATE document_versions SET deleted_at = now() WHERE document_id = ANY($1) AND deleted_at IS NULL', [docs.map((r) => r.id_private)]);
    await q('UPDATE project_members SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL', [id]);
    await q('UPDATE project_roles SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL', [id]);
    res.json({ ok: true, removedFeedbacks: removed.length });
  })
);

projectsRouter.post(
  '/projects/:id/invoice-task',
  route(async (req, res) => {
    const id = (await privateId('projects', req.params.id as string, true)) ?? notFound('Không tìm thấy dự án.');
    const project = (await q1('SELECT name, invoice_feedback_id FROM projects WHERE id_private = $1', [id]))!;
    if (project.invoice_feedback_id) throw new HttpError(409, 'Dự án đã có công việc xuất hóa đơn tổng.');
    const paid = await q<{ amount: number }>('SELECT amount FROM payment_rounds WHERE project_id = $1 AND paid AND company_account AND deleted_at IS NULL', [id]);
    if (!paid.length) bad('Chưa có đợt nào đã thanh toán qua tài khoản công ty.');
    const total = paid.reduce((sum, p) => sum + p.amount, 0);
    const taskId = await createInvoiceTask(id, `Xuất hóa đơn công ty - ${project.name}`, `${paid.length} đợt thanh toán bằng tài khoản công ty · ${total.toLocaleString('vi-VN')} ₫`, 'Thành viên');
    await q('UPDATE projects SET invoice_feedback_id = $2 WHERE id_private = $1', [id, taskId]);
    res.status(201).json(await loadFeedback(taskId));
  })
);
