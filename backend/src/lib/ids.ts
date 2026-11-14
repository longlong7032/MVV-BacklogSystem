// Sinh định danh công khai (id_public) dạng UUID v7 (RFC 9562): 48 bit thời gian (ms) + bit ngẫu nhiên.
// Ưu điểm so với v4: tăng dần theo thời gian (index B-tree gọn, sắp xếp được), vẫn không đoán được.
import crypto from 'node:crypto';

/** UUID v7 mới, vd "0193a6f2-7c1e-7b3a-9f5d-2c8e41a0b6d4". */
export function uuidv7(): string {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Chuỗi có đúng dạng UUID không (dùng để lọc tham số URL trước khi truy vấn). */
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
