/**
 * Kho file tải lên (ảnh, HAR, tài liệu): bảng `files` giữ thông tin; bytes nằm ở Cloudflare R2 (nếu cấu hình đủ R2_*)
 * hoặc ngay trong cột `files.data` (bytea). URL công khai: `/uploads/<storage_key>`.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { q, q1 } from '../db/pool.js';
import { uuidv7 } from './ids.js';
import { createR2FromEnv } from './r2.js';

/** File đã nhận từ request, chờ lưu. */
export interface StoredUpload {
  /** Tên lưu trữ (UUID + đuôi). */
  name: string;
  mime: string;
  size: number;
  originalname?: string;
  buffer: Buffer;
}

/** File đọc ra từ kho. */
export interface StoredFile {
  buffer: Buffer;
  mime: string;
}

/** Một file đã lưu: id nội bộ (để gắn khóa ngoại) + URL công khai. */
export interface SavedFile {
  idPrivate: number;
  url: string;
  name: string;
  size: number;
  mime: string;
}

const r2 = createR2FromEnv();

/** Kho đang dùng: 'r2' hoặc 'db'. */
export const blobMode = (): 'r2' | 'db' => (r2 ? 'r2' : 'db');

/** URL công khai của file theo storage_key. */
export const fileUrl = (storageKey: string): string => '/uploads/' + storageKey;

/**
 * Lưu một file (gọi trong transaction của request). Ghi lên R2 trước rồi mới ghi dòng `files`:
 * nếu transaction sau đó bị hủy, file trên R2 thành rác nhưng dữ liệu không trỏ tới file không tồn tại.
 */
export async function saveFile(upload: Omit<StoredUpload, 'name'> & { ext: string }): Promise<SavedFile> {
  const storageKey = crypto.randomUUID() + upload.ext;
  if (r2) await r2.put({ name: storageKey, mime: upload.mime, size: upload.size, buffer: upload.buffer });
  const row = await q1<{ id_private: number }>(
    `INSERT INTO files (id_public, storage_key, storage, mime, size, original_name, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id_private`,
    [uuidv7(), storageKey, r2 ? 'r2' : 'db', upload.mime, upload.size, (upload.originalname || '').slice(0, 255), r2 ? null : upload.buffer]
  );
  return { idPrivate: row!.id_private, url: fileUrl(storageKey), name: upload.originalname || storageKey, size: upload.size, mime: upload.mime };
}

/** Đọc file theo storage_key (bỏ qua file đã xóa mềm); không có -> null. */
export async function readFile(storageKey: string): Promise<StoredFile | null> {
  const key = path.basename(storageKey);
  const row = await q1<{ storage: string; mime: string; data: Buffer | null }>(
    'SELECT storage, mime, data FROM files WHERE storage_key = $1 AND deleted_at IS NULL',
    [key]
  );
  if (!row) return null;
  if (row.storage === 'db') return row.data ? { buffer: row.data, mime: row.mime } : null;
  if (!r2) return null;
  const file = await r2.get(key);
  return file ? { buffer: file.buffer, mime: row.mime || file.mime } : null;
}

/** Xóa mềm các file theo id nội bộ (bytes giữ lại để có thể khôi phục). */
export async function softDeleteFiles(ids: number[]): Promise<void> {
  if (ids.length) await q('UPDATE files SET deleted_at = now() WHERE id_private = ANY($1) AND deleted_at IS NULL', [ids]);
}
