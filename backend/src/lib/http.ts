/** Tiện ích HTTP dùng chung cho các module API. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isUuid } from './ids.js';

/** Lỗi nghiệp vụ có mã HTTP; error handler trả về `{ error, code? }`. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

/** Ném HttpError 400 (dữ liệu không hợp lệ). */
export const bad = (message: string): never => {
  throw new HttpError(400, message);
};

/** Ném HttpError 404. */
export const notFound = (message: string): never => {
  throw new HttpError(404, message);
};

/** Ép giá trị bất kỳ về chuỗi đã cắt khoảng trắng; không phải chuỗi -> ''. */
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Tham số id công khai (UUID) từ URL / body; sai định dạng -> ''. */
export const uuidParam = (v: unknown): string => (isUuid(str(v)) ? str(v).toLowerCase() : '');

/** Timestamp (Date | null) -> ISO-8601 | null. */
export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** Timestamp bắt buộc -> ISO-8601. */
export const isoReq = (d: Date | string): string => new Date(d).toISOString();

/** Ngày 'YYYY-MM-DD' hợp lệ hoặc rỗng. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** So sánh hai tên không phân biệt hoa/thường và dấu (theo locale tiếng Việt). */
export const sameName = (a: string, b: string): boolean => a.localeCompare(b, 'vi', { sensitivity: 'base' }) === 0;

/** Bọc handler async: lỗi được chuyển cho error handler của Express. */
export const route =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
