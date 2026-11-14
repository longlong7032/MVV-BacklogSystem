/**
 * Tài liệu PTYC (phân tích yêu cầu) của dự án; mỗi lần tải file lên là một phiên bản.
 *   GET    /api/documents                     ?project=<idPublic>
 *   POST   /api/documents                     multipart: project_id, title, doc_type, status, note, version, version_note, document_file (bắt buộc)
 *   PUT    /api/documents/:id                 JSON: { title, docType, status, note }
 *   PATCH  /api/documents/:id/status          { status: 'draft' | 'review' | 'approved' }
 *   POST   /api/documents/:id/versions        multipart: version, version_note, document_file
 *   DELETE /api/documents/:id                 xóa mềm tài liệu + các phiên bản
 */
import { Router } from 'express';
import { q, q1 } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { bad, isoReq, notFound, route, str, uuidParam } from '../lib/http.js';
import { fileUrl } from '../lib/blobs.js';
import { DOC_FIELD, saveUploaded, uploadFields } from '../lib/upload.js';
import { recordActivity } from './activity.js';
import type { DocumentStatus, ProjectDocument } from '../types.js';

const STATUSES: DocumentStatus[] = ['draft', 'review', 'approved'];
const STATUS_LABELS: Record<DocumentStatus, string> = { draft: 'Nháp', review: 'Chờ duyệt', approved: 'Đã duyệt' };

/** Dựng DTO cho các dòng tài liệu (kèm phiên bản, mới nhất trước). */
async function toDocuments(rows: Record<string, any>[]): Promise<ProjectDocument[]> {
  const ids = rows.map((r) => r.id_private);
  const versions = ids.length
    ? await q(
        `SELECT v.*, fl.storage_key, fl.original_name, fl.size, fl.mime FROM document_versions v JOIN files fl ON fl.id_private = v.file_id
         WHERE v.deleted_at IS NULL AND v.document_id = ANY($1) ORDER BY v.created_at DESC, v.id_private DESC`,
        [ids]
      )
    : [];
  return rows.map((r) => ({
    idPublic: r.id_public,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    projectId: r.project_pid,
    title: r.title,
    docType: r.doc_type,
    status: r.status,
    note: r.note,
    versions: versions
      .filter((v) => v.document_id === r.id_private)
      .map((v) => ({
        idPublic: v.id_public,
        createdAt: isoReq(v.created_at),
        updatedAt: isoReq(v.updated_at),
        version: v.version,
        note: v.note,
        uploadedBy: v.uploaded_by,
        file: { url: fileUrl(v.storage_key), name: v.original_name || v.storage_key, size: v.size, mime: v.mime },
      })),
  }));
}

const SELECT = `SELECT d.*, p.id_public AS project_pid FROM documents d JOIN projects p ON p.id_private = d.project_id`;

export async function listDocuments(projectPublicId = ''): Promise<ProjectDocument[]> {
  return toDocuments(
    await q(`${SELECT} WHERE d.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.id_public = $1::uuid) ORDER BY d.updated_at DESC`, [projectPublicId || null])
  );
}

const loadDocument = async (id: number): Promise<ProjectDocument> => (await toDocuments(await q(`${SELECT} WHERE d.id_private = $1`, [id])))[0]!;

/** Kiểm tra thông tin chung của tài liệu. */
function readMeta(b: Record<string, unknown>): { title: string; docType: string; status: DocumentStatus; note: string } {
  const title = str(b.title);
  if (!title) bad('Vui lòng nhập tên tài liệu.');
  if (title.length > 200) bad('Tên tài liệu tối đa 200 ký tự.');
  const docType = str(b.docType ?? b.doc_type);
  if (docType.length > 60) bad('Loại tài liệu tối đa 60 ký tự.');
  const status = (str(b.status) || 'draft') as DocumentStatus;
  if (!STATUSES.includes(status)) bad('Trạng thái tài liệu không hợp lệ.');
  const note = str(b.note);
  if (note.length > 2000) bad('Ghi chú tối đa 2000 ký tự.');
  return { title, docType, status, note };
}

/** Kiểm tra thông tin phiên bản. */
function readVersion(b: Record<string, unknown>, fallback: string): { version: string; note: string } {
  const version = str(b.version) || fallback;
  if (version.length > 30) bad('Tên phiên bản tối đa 30 ký tự.');
  const note = str(b.version_note);
  if (note.length > 1000) bad('Ghi chú phiên bản tối đa 1000 ký tự.');
  return { version, note };
}

export const documentsRouter = Router();

documentsRouter.get('/documents', route(async (req, res) => void res.json(await listDocuments(uuidParam(req.query.project)))));

documentsRouter.post(
  '/documents',
  uploadFields,
  route(async (req, res) => {
    const b = req.body || {};
    const projectId = (await privateId('projects', str(b.project_id))) ?? bad('Không tìm thấy dự án.');
    const meta = readMeta(b);
    const ver = readVersion(b, 'v1.0');
    const file = (await saveUploaded(req, DOC_FIELD))[0] ?? bad('Vui lòng chọn file tài liệu (PDF, Word, Excel, PowerPoint, ảnh, zip).');
    const publicId = uuidv7();
    const row = await q1('INSERT INTO documents (id_public, project_id, title, doc_type, status, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_private', [
      publicId, projectId, meta.title, meta.docType, meta.status, meta.note,
    ]);
    await q('INSERT INTO document_versions (id_public, document_id, file_id, version, note, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      uuidv7(), row!.id_private, file.idPrivate, ver.version, ver.note, 'Thành viên',
    ]);
    await recordActivity({ projectId: projectId as number, entityType: 'ptyc', entityPublicId: publicId, entityTitle: meta.title, action: 'created', actor: 'Thành viên', details: [`Tải lên ${ver.version}`] });
    res.status(201).json(await loadDocument(row!.id_private));
  })
);

documentsRouter.put(
  '/documents/:id',
  route(async (req, res) => {
    const id = (await privateId('documents', req.params.id as string, true)) ?? notFound('Không tìm thấy tài liệu.');
    const before = (await q1('SELECT * FROM documents WHERE id_private = $1', [id]))!;
    const meta = readMeta(req.body || {});
    await q('UPDATE documents SET title = $2, doc_type = $3, status = $4, note = $5 WHERE id_private = $1', [id, meta.title, meta.docType, meta.status, meta.note]);
    const details: string[] = [];
    if (before.title !== meta.title) details.push('Đổi tên tài liệu');
    if (before.doc_type !== meta.docType) details.push('Đổi loại tài liệu');
    if (before.status !== meta.status) details.push(`Trạng thái: ${STATUS_LABELS[before.status as DocumentStatus]} → ${STATUS_LABELS[meta.status]}`);
    if (before.note !== meta.note) details.push('Sửa ghi chú');
    await recordActivity({ projectId: before.project_id, entityType: 'ptyc', entityPublicId: before.id_public, entityTitle: meta.title, action: 'updated', actor: 'Thành viên', details: details.length ? details : ['Cập nhật tài liệu'] });
    res.json(await loadDocument(id));
  })
);

documentsRouter.patch(
  '/documents/:id/status',
  route(async (req, res) => {
    const id = (await privateId('documents', req.params.id as string, true)) ?? notFound('Không tìm thấy tài liệu.');
    const status = str((req.body || {}).status) as DocumentStatus;
    if (!STATUSES.includes(status)) bad('Trạng thái tài liệu không hợp lệ.');
    const before = (await q1('SELECT * FROM documents WHERE id_private = $1', [id]))!;
    if (before.status !== status) {
      await q('UPDATE documents SET status = $2 WHERE id_private = $1', [id, status]);
      await recordActivity({ projectId: before.project_id, entityType: 'ptyc', entityPublicId: before.id_public, entityTitle: before.title, action: 'status', actor: 'Thành viên', details: [`Trạng thái: ${STATUS_LABELS[before.status as DocumentStatus]} → ${STATUS_LABELS[status]}`] });
    }
    res.json(await loadDocument(id));
  })
);

documentsRouter.post(
  '/documents/:id/versions',
  uploadFields,
  route(async (req, res) => {
    const id = (await privateId('documents', req.params.id as string, true)) ?? notFound('Không tìm thấy tài liệu.');
    const doc = (await q1('SELECT * FROM documents WHERE id_private = $1', [id]))!;
    const count = (await q1<{ n: number }>('SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1 AND deleted_at IS NULL', [id]))!.n;
    const ver = readVersion(req.body || {}, `v${count + 1}.0`);
    const file = (await saveUploaded(req, DOC_FIELD))[0] ?? bad('Vui lòng chọn file cho phiên bản mới.');
    await q('INSERT INTO document_versions (id_public, document_id, file_id, version, note, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      uuidv7(), id, file.idPrivate, ver.version, ver.note, 'Thành viên',
    ]);
    // Có phiên bản mới thì cần duyệt lại
    await q("UPDATE documents SET status = CASE WHEN status = 'approved' THEN 'review' ELSE status END WHERE id_private = $1", [id]);
    await recordActivity({ projectId: doc.project_id, entityType: 'ptyc', entityPublicId: doc.id_public, entityTitle: doc.title, action: 'updated', actor: 'Thành viên', details: [`Tải lên ${ver.version}`] });
    res.status(201).json(await loadDocument(id));
  })
);

documentsRouter.delete(
  '/documents/:id',
  route(async (req, res) => {
    const id = (await privateId('documents', req.params.id as string, true)) ?? notFound('Không tìm thấy tài liệu.');
    const doc = (await q1('UPDATE documents SET deleted_at = now() WHERE id_private = $1 RETURNING *', [id]))!;
    await q('UPDATE document_versions SET deleted_at = now() WHERE document_id = $1 AND deleted_at IS NULL', [id]);
    await recordActivity({ projectId: doc.project_id, entityType: 'ptyc', entityPublicId: doc.id_public, entityTitle: doc.title, action: 'deleted', actor: 'Thành viên', details: ['Xóa tài liệu'] });
    res.json({ ok: true });
  })
);
