/** Tra id nội bộ (id_private) từ id công khai — chỉ dùng bên trong backend, không bao giờ trả ra API. */
import { q1 } from './pool.js';
import { isUuid } from '../lib/ids.js';

/** Các bảng cho phép tra (chặn tên bảng tùy ý vào SQL). */
type Table = 'projects' | 'teams' | 'users' | 'feedbacks' | 'payment_rounds' | 'documents';

/**
 * id_private của bản ghi còn hiệu lực (chưa xóa mềm) có id_public = `publicId`.
 * @param forUpdate khóa dòng tới hết transaction (dùng khi sắp sửa / cấp STT)
 * @returns null nếu không tồn tại / đã xóa / id sai định dạng
 */
export async function privateId(table: Table, publicId: string, forUpdate = false): Promise<number | null> {
  if (!isUuid(publicId)) return null;
  const row = await q1<{ id_private: number }>(
    `SELECT id_private FROM ${table} WHERE id_public = $1 AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
    [publicId]
  );
  return row?.id_private ?? null;
}
