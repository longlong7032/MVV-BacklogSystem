/**
 * Nhận file tải lên (multipart): ảnh (nén sang WebP), file HAR, tài liệu PTYC.
 * File được giữ trong bộ nhớ; handler gọi `saveUploaded()` trong transaction của request để lưu vào kho (blobs.ts).
 */
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { compressImage } from './image.js';
import { saveFile } from './blobs.js';
import type { SavedFile } from './blobs.js';
import { HttpError } from './http.js';
import { resumeTx } from '../db/pool.js';

/** Đuôi file tương ứng với từng loại ảnh được phép tải lên. */
const EXT_BY_MIME: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/** Đuôi tài liệu PTYC được phép. */
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt|md|png|jpe?g|webp|zip)$/i;

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB mỗi ảnh
export const MAX_REQUEST_BYTES = Math.floor(4.2 * 1024 * 1024); // Vercel giới hạn body 4.5MB mỗi request
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB mỗi file HAR / tài liệu

/** Field chứa file HAR / tài liệu. */
export const HAR_FIELD = 'har_file';
export const DOC_FIELD = 'document_file';

/** Các field ảnh được nhận. */
const IMAGE_FIELDS = ['location_image', 'payment_image', 'bug_images', 'expected_images'];

/** Các file multer nhận được, nhóm theo tên field. */
export type UploadedFiles = Record<string, Express.Multer.File[]>;

const isHar = (f: Express.Multer.File): boolean =>
  /\.har$/i.test(f.originalname) || ['application/json', 'application/octet-stream'].includes(f.mimetype);

const multerFields = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 31 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === HAR_FIELD) return cb(null, isHar(file));
    if (file.fieldname === DOC_FIELD) return cb(null, DOC_EXT.test(file.originalname));
    cb(null, IMAGE_FIELDS.includes(file.fieldname) && Boolean(EXT_BY_MIME[file.mimetype]));
  },
}).fields([
  { name: 'location_image', maxCount: 1 },
  { name: 'payment_image', maxCount: 1 },
  { name: 'bug_images', maxCount: 10 },
  { name: 'expected_images', maxCount: 10 },
  { name: HAR_FIELD, maxCount: 1 },
  { name: DOC_FIELD, maxCount: 1 },
]);

/** Middleware: nhận multipart, kiểm tra giới hạn ảnh, nén ảnh sang WebP (lỗi nén thì giữ ảnh gốc). */
export function uploadFields(req: Request, res: Response, next: NextFunction): void {
  // Callback của multer chạy từ luồng mạng (mất ngữ cảnh) -> vào lại transaction của request
  multerFields(req, res, (err: unknown) => resumeTx(req, () => {
    if (err) return next(err);
    const files = filesOf(req);
    if (files.some((f) => IMAGE_FIELDS.includes(f.fieldname) && f.size > MAX_IMAGE_SIZE)) return next(new HttpError(400, 'Ảnh vượt quá 10MB.'));
    Promise.all(
      files
        .filter((f) => IMAGE_FIELDS.includes(f.fieldname))
        .map(async (f) => {
          try {
            const out = await compressImage(f.buffer, f.mimetype);
            if (out.ext) Object.assign(f, { buffer: out.buffer, size: out.buffer.length, mimetype: out.mime });
          } catch {
            // giữ ảnh gốc
          }
        })
    ).then(() => next(), next);
  }));
}

/** Mọi file của request (nhiều field) thành một mảng phẳng. */
const filesOf = (req: Request): Express.Multer.File[] =>
  Array.isArray(req.files) ? req.files : Object.values((req.files || {}) as UploadedFiles).flat();

/** Các file của một field. */
export const fieldFiles = (req: Request, field: string): Express.Multer.File[] => ((req.files || {}) as UploadedFiles)[field] || [];

/** Lưu các file của một field vào kho (trong transaction hiện tại). */
export async function saveUploaded(req: Request, field: string): Promise<SavedFile[]> {
  const saved: SavedFile[] = [];
  for (const f of fieldFiles(req, field)) {
    const isImage = IMAGE_FIELDS.includes(field);
    const ext = isImage ? EXT_BY_MIME[f.mimetype] || '.png' : field === HAR_FIELD ? '.har' : (/\.[a-z0-9]{1,5}$/i.exec(f.originalname)?.[0] || '').toLowerCase();
    saved.push(
      await saveFile({
        ext,
        mime: field === HAR_FIELD ? 'application/json' : f.mimetype || 'application/octet-stream',
        size: f.size,
        originalname: f.originalname || (field === HAR_FIELD ? 'network.har' : ''),
        buffer: f.buffer,
      })
    );
  }
  return saved;
}
