/**
 * Gọi API của server (JSON hoặc multipart). Cookie phiên quản trị được trình duyệt tự đính kèm.
 */

/** Lỗi trả về từ API, kèm mã lỗi (`admin-auth`, `admin-setup`, ...) nếu có. */
export type ApiError = Error & { code?: string };

/**
 * Gọi API và trả JSON; ném `Error` với thông điệp thân thiện khi server báo lỗi
 * (kể cả 413 do vượt dung lượng upload).
 */
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 413) {
    throw new Error('Dung lượng tải lên quá lớn (tối đa khoảng 4MB mỗi lần lưu). Hãy bớt ảnh hoặc dùng ảnh nhỏ hơn.');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Có lỗi xảy ra, vui lòng thử lại.'), { code: data.code }) as ApiError;
  return data;
}

/** Tạo tuỳ chọn fetch gửi body JSON. */
export const jsonBody = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
