/**
 * Gọi API của server (JSON hoặc multipart). Cookie phiên quản trị được trình duyệt tự đính kèm.
 *
 * Mọi lỗi (mất mạng, server lỗi, 4xx) đều thành `ApiError` với thông điệp tiếng Việt thân thiện,
 * nên chỗ gọi chỉ cần `catch (err)` rồi hiện `err.message` (hoặc để `reportError()` lo — xem errors.ts).
 */

/** Lỗi từ API: `status` là mã HTTP (0 = không nhận được phản hồi), `code` là mã nghiệp vụ của server (vd `admin-auth`). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thông điệp mặc định khi server không kèm lời giải thích, theo mã HTTP. */
function fallbackMessage(status: number): string {
  if (status === 404) return 'Không tìm thấy dữ liệu (có thể đã bị xóa). Hãy tải lại trang.';
  if (status === 409) return 'Dữ liệu vừa bị người khác thay đổi hoặc bị trùng. Hãy tải lại trang rồi thử lại.';
  if (status === 413) return 'Dung lượng tải lên quá lớn (tối đa khoảng 4MB mỗi lần lưu). Hãy bớt ảnh hoặc dùng ảnh nhỏ hơn.';
  if (status === 429) return 'Bạn thao tác quá nhanh, hãy chờ một lát rồi thử lại.';
  if (status === 502 || status === 503 || status === 504) return 'Máy chủ tạm thời không phản hồi, vui lòng thử lại sau ít phút.';
  if (status >= 500) return 'Lỗi hệ thống, vui lòng thử lại sau.';
  return 'Có lỗi xảy ra, vui lòng thử lại.';
}

/**
 * Gọi API và trả JSON; ném `ApiError` khi lỗi.
 *  - mất mạng / không tới được máy chủ  -> status 0, code `network`
 *  - 413 (vượt dung lượng upload) luôn dùng thông điệp riêng vì proxy thường trả HTML thay vì JSON
 *  - còn lại: dùng `error` của server nếu có, không thì thông điệp theo mã HTTP
 */
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.', 0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 413) throw new ApiError(fallbackMessage(413), 413, data.code);
  if (!res.ok) throw new ApiError(data.error || fallbackMessage(res.status), res.status, data.code);
  return data;
}

/** Tạo tuỳ chọn fetch gửi body JSON. */
export const jsonBody = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
