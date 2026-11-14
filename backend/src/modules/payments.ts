/**
 * Đợt thanh toán của dự án.
 *   GET    /api/payments                     ?project=<idPublic>
 *   POST   /api/payments                     multipart: project_id, name, amount, note, paid_at, paid ('1'), company_account ('1'), payment_image
 *   PUT    /api/payments/:id                 (như POST, không đổi dự án) + remove_image ('1')
 *   PATCH  /api/payments/:id/status          { paid: boolean }
 *   POST   /api/payments/:id/invoice-task    tạo backlog "xuất hóa đơn" cho đợt đã thu qua tài khoản công ty
 *   DELETE /api/payments/:id                 xóa mềm
 */
import { Router } from 'express';
import type { Request } from 'express';
import { q, q1 } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { DATE_RE, HttpError, bad, isoReq, notFound, route, str, uuidParam } from '../lib/http.js';
import { fileUrl, softDeleteFiles } from '../lib/blobs.js';
import { saveUploaded, uploadFields } from '../lib/upload.js';
import { recordActivity } from './activity.js';
import { createInvoiceTask, loadFeedback } from './feedbacks.js';
import type { PaymentRound } from '../types.js';

const SELECT = `
  SELECT r.*, p.id_public AS project_pid, fl.storage_key AS image_key, f.id_public AS invoice_pid
  FROM payment_rounds r
  JOIN projects p ON p.id_private = r.project_id
  LEFT JOIN files fl ON fl.id_private = r.image_file_id AND fl.deleted_at IS NULL
  LEFT JOIN feedbacks f ON f.id_private = r.invoice_feedback_id AND f.deleted_at IS NULL`;

const toPayment = (r: Record<string, any>): PaymentRound => ({
  idPublic: r.id_public,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
  projectId: r.project_pid,
  stt: r.stt,
  name: r.name,
  amount: r.amount,
  note: r.note,
  paidAt: r.paid_at || '',
  image: r.image_key ? fileUrl(r.image_key) : '',
  paid: r.paid,
  companyAccount: r.company_account,
  invoiceFeedbackId: r.invoice_pid || '',
});

export async function listPayments(projectPublicId = ''): Promise<PaymentRound[]> {
  const rows = await q(
    `${SELECT} WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.id_public = $1::uuid) ORDER BY p.name, r.stt`,
    [projectPublicId || null]
  );
  return rows.map(toPayment);
}

const loadPayment = async (id: number): Promise<PaymentRound> => toPayment((await q1(`${SELECT} WHERE r.id_private = $1`, [id]))!);

/** Đọc + kiểm tra form đợt thanh toán. */
function readForm(req: Request) {
  const b = req.body || {};
  const name = str(b.name);
  const amount = Number(b.amount);
  const note = str(b.note);
  const paidAt = str(b.paid_at);
  if (!name || name.length > 160) bad('Tên đợt thanh toán không hợp lệ (tối đa 160 ký tự).');
  if (!str(b.amount) || !Number.isSafeInteger(Math.round(amount)) || amount < 0) bad('Số tiền phải là số không âm.');
  if (note.length > 2000) bad('Ghi chú tối đa 2000 ký tự.');
  if (paidAt && !DATE_RE.test(paidAt)) bad('Ngày thanh toán không hợp lệ.');
  return { name, amount: Math.round(amount), note, paidAt: paidAt || null, paid: b.paid === '1', companyAccount: b.company_account === '1' };
}

const PAID_NEEDS = 'Khi đánh dấu đã thanh toán, cần nhập ngày và đính kèm hình ảnh biên nhận.';

export const paymentsRouter = Router();

paymentsRouter.get('/payments', route(async (req, res) => void res.json(await listPayments(uuidParam(req.query.project)))));

paymentsRouter.post(
  '/payments',
  uploadFields,
  route(async (req, res) => {
    const projectId = (await privateId('projects', str((req.body || {}).project_id), true)) ?? bad('Không tìm thấy dự án.');
    const v = readForm(req);
    const image = (await saveUploaded(req, 'payment_image'))[0];
    if (v.paid && (!image || !v.paidAt)) bad(PAID_NEEDS);
    const stt = (await q1<{ n: number }>('SELECT COALESCE(MAX(stt), 0) + 1 AS n FROM payment_rounds WHERE project_id = $1', [projectId]))!.n;
    const publicId = uuidv7();
    const row = await q1(
      `INSERT INTO payment_rounds (id_public, project_id, stt, name, amount, note, paid_at, paid, company_account, image_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id_private`,
      [publicId, projectId, stt, v.name, v.amount, v.note, v.paidAt, v.paid, v.companyAccount, image?.idPrivate ?? null]
    );
    await recordActivity({ projectId: projectId as number, entityType: 'payment', entityPublicId: publicId, entityTitle: v.name, action: 'created', actor: 'Thành viên', details: ['Tạo đợt thanh toán'] });
    res.status(201).json(await loadPayment(row!.id_private));
  })
);

paymentsRouter.put(
  '/payments/:id',
  uploadFields,
  route(async (req, res) => {
    const id = (await privateId('payment_rounds', req.params.id as string, true)) ?? notFound('Không tìm thấy đợt thanh toán.');
    const before = (await q1('SELECT * FROM payment_rounds WHERE id_private = $1', [id]))!;
    const v = readForm(req);
    const removeImage = (req.body || {}).remove_image === '1';
    const image = (await saveUploaded(req, 'payment_image'))[0];
    const keepsImage = Boolean(image) || (!removeImage && Boolean(before.image_file_id));
    if (v.paid && (!v.paidAt || !keepsImage)) bad(PAID_NEEDS);
    let imageFileId = before.image_file_id as number | null;
    if (image || removeImage) {
      if (before.image_file_id) await softDeleteFiles([before.image_file_id]);
      imageFileId = image?.idPrivate ?? null;
    }
    await q(
      `UPDATE payment_rounds SET name = $2, amount = $3, note = $4, paid_at = $5, paid = $6, company_account = $7, image_file_id = $8 WHERE id_private = $1`,
      [id, v.name, v.amount, v.note, v.paidAt, v.paid, v.companyAccount, imageFileId]
    );
    const details: string[] = [];
    if (before.name !== v.name) details.push('Đổi tên đợt thanh toán');
    if (before.amount !== v.amount) details.push('Thay đổi số tiền');
    if (before.note !== v.note) details.push('Sửa ghi chú');
    if ((before.paid_at || null) !== v.paidAt) details.push('Thay đổi ngày thanh toán');
    if (before.paid !== v.paid) details.push(v.paid ? 'Đánh dấu đã thanh toán' : 'Bỏ trạng thái đã thanh toán');
    if (before.company_account !== v.companyAccount) details.push(v.companyAccount ? 'Thanh toán qua tài khoản công ty' : 'Bỏ hình thức tài khoản công ty');
    if (image || removeImage) details.push('Thay đổi hình ảnh');
    await recordActivity({ projectId: before.project_id, entityType: 'payment', entityPublicId: before.id_public, entityTitle: v.name, action: 'updated', actor: 'Thành viên', details: details.length ? details : ['Cập nhật đợt thanh toán'] });
    res.json(await loadPayment(id));
  })
);

paymentsRouter.patch(
  '/payments/:id/status',
  route(async (req, res) => {
    const id = (await privateId('payment_rounds', req.params.id as string, true)) ?? notFound('Không tìm thấy đợt thanh toán.');
    const round = (await q1('SELECT * FROM payment_rounds WHERE id_private = $1', [id]))!;
    const paid = Boolean((req.body || {}).paid);
    if (paid && (!round.paid_at || !round.image_file_id)) bad('Cần nhập ngày và đính kèm hình ảnh biên nhận trước khi đánh dấu đã thanh toán.');
    if (round.paid !== paid) {
      await q('UPDATE payment_rounds SET paid = $2 WHERE id_private = $1', [id, paid]);
      await recordActivity({ projectId: round.project_id, entityType: 'payment', entityPublicId: round.id_public, entityTitle: round.name, action: 'updated', actor: 'Thành viên', details: [paid ? 'Đánh dấu đã thanh toán' : 'Bỏ trạng thái đã thanh toán'] });
    }
    res.json(await loadPayment(id));
  })
);

paymentsRouter.post(
  '/payments/:id/invoice-task',
  route(async (req, res) => {
    const id = (await privateId('payment_rounds', req.params.id as string, true)) ?? notFound('Không tìm thấy đợt thanh toán.');
    const round = (await q1('SELECT * FROM payment_rounds WHERE id_private = $1', [id]))!;
    if (!round.paid || !round.company_account) bad('Chỉ tạo công việc hóa đơn cho đợt đã thanh toán bằng tài khoản công ty.');
    if (round.invoice_feedback_id) throw new HttpError(409, 'Đợt này đã có công việc xuất hóa đơn.');
    const taskId = await createInvoiceTask(round.project_id, `Xuất hóa đơn công ty - ${round.name}`, `Đợt thanh toán #${round.stt} · ${Number(round.amount).toLocaleString('vi-VN')} ₫`, 'Thành viên');
    await q('UPDATE payment_rounds SET invoice_feedback_id = $2 WHERE id_private = $1', [id, taskId]);
    res.status(201).json(await loadFeedback(taskId));
  })
);

paymentsRouter.delete(
  '/payments/:id',
  route(async (req, res) => {
    const id = (await privateId('payment_rounds', req.params.id as string, true)) ?? notFound('Không tìm thấy đợt thanh toán.');
    const round = (await q1('UPDATE payment_rounds SET deleted_at = now() WHERE id_private = $1 RETURNING *', [id]))!;
    await recordActivity({ projectId: round.project_id, entityType: 'payment', entityPublicId: round.id_public, entityTitle: round.name, action: 'deleted', actor: 'Thành viên', details: ['Xóa đợt thanh toán'] });
    res.json({ ok: true });
  })
);
