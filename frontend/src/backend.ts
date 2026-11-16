/**
 * Client gọi BACKEND qua HTTP (phía server của frontend).
 *
 * Frontend không đọc DB và không import code của backend: mọi dữ liệu đều đi qua API `/api/...`.
 * Cookie đăng nhập quản trị của trình duyệt được chuyển tiếp để backend nhận biết người dùng.
 *
 * FRONTEND và BACKEND là hai địa chỉ KHÁC NHAU (mặc định local: frontend :4000, backend :3000).
 * Địa chỉ backend chỉ lấy từ `BACKEND_URL` — không tự suy ra từ request — và được kiểm tra để không trỏ ngược về
 * chính frontend (nếu trỏ nhầm, proxy `/api` sẽ gọi lại chính nó vô hạn).
 */
import type { Request } from 'express';
import type { ActivityEntry, AuditEntry, Feedback, McpInfo, PaymentRound, Profile, Project, ProjectDocument, ProjectMember, PublicUser, Team } from './types.js';
import type { Data, UsersData } from './pages/index.js';

/** Địa chỉ backend mặc định khi chạy local (khớp PORT mặc định của backend). */
const LOCAL_BACKEND_URL = 'http://localhost:3000';

/** Đang chạy production (Vercel hoặc NODE_ENV=production): bắt buộc khai báo BACKEND_URL, không dùng mặc định local. */
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

const rawBackendUrl = (process.env.BACKEND_URL || '').trim();

/** Địa chỉ backend (không có dấu / cuối). Rỗng nếu chưa cấu hình trên production. */
export const BACKEND_URL = (rawBackendUrl || (IS_PRODUCTION ? '' : LOCAL_BACKEND_URL)).replace(/\/+$/, '');

/** Lỗi cấu hình BACKEND_URL (rỗng = hợp lệ). Khi có lỗi, frontend không proxy / không gọi backend. */
export const BACKEND_CONFIG_ERROR: string = (() => {
  if (!BACKEND_URL) return 'Chưa cấu hình BACKEND_URL cho frontend (vd https://ten-backend.vercel.app).';
  try {
    const u = new URL(BACKEND_URL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `BACKEND_URL phải bắt đầu bằng http:// hoặc https:// (đang là "${BACKEND_URL}").`;
  } catch {
    return `BACKEND_URL không phải URL hợp lệ (đang là "${BACKEND_URL}").`;
  }
  return '';
})();

/** Host (vd `localhost:3000`) của backend, để so với host của frontend. */
const BACKEND_HOST = BACKEND_CONFIG_ERROR ? '' : new URL(BACKEND_URL).host.toLowerCase();

/**
 * Header frontend gắn vào mọi request gửi sang backend. Nếu frontend lại nhận được request có header này,
 * nghĩa là BACKEND_URL đang trỏ về chính frontend (vòng lặp) → từ chối ngay thay vì gọi đệ quy.
 */
export const FRONTEND_MARK_HEADER = 'x-feedback-frontend';

/** Thông báo khi BACKEND_URL trỏ về chính frontend. */
export const SELF_TARGET_ERROR =
  'BACKEND_URL đang trỏ về chính frontend. Đặt BACKEND_URL là địa chỉ của backend (khác địa chỉ frontend), vd local http://localhost:3000.';

/** BACKEND_URL có cùng host với frontend đang nhận request `req` không. */
export const pointsToSelf = (req: Request): boolean => Boolean(BACKEND_HOST) && BACKEND_HOST === (req.get('host') || '').toLowerCase();

/** Lỗi cấu hình áp dụng cho request này ('' = ổn). */
export const backendErrorFor = (req: Request): string => BACKEND_CONFIG_ERROR || (pointsToSelf(req) ? SELF_TARGET_ERROR : '');

/** Kết quả một lần gọi backend. */
interface BackendResponse<T> {
  status: number;
  ok: boolean;
  body: T & { code?: string; error?: string };
}

/**
 * Gọi `GET <BACKEND_URL><path>`, chuyển tiếp cookie của request và địa chỉ IP thật của người dùng
 * (để giới hạn tốc độ / khóa IP của backend tính đúng người).
 * @throws nếu cấu hình BACKEND_URL sai hoặc không kết nối được backend
 */
export async function backendGet<T>(req: Request, path: string): Promise<BackendResponse<T>> {
  const configError = backendErrorFor(req);
  if (configError) throw new Error(configError);
  const headers: Record<string, string> = {
    [FRONTEND_MARK_HEADER]: '1',
    'x-forwarded-for': req.ip || '',
    'x-forwarded-proto': req.protocol,
    'x-forwarded-host': req.get('host') || '',
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  const res = await fetch(BACKEND_URL + path, { headers, signal: AbortSignal.timeout(15000) });
  const body = (await res.json().catch(() => ({}))) as BackendResponse<T>['body'];
  return { status: res.status, ok: res.ok, body };
}

/** Lấy dự án, team, backlog, ...: MỘT request `/api/bootstrap`; ném lỗi nếu backend trả lỗi. */
/** Token MCP theo dự án của một nhân sự (chỉ gợi ý, không có token gốc). */
export interface ProjectTokenInfo { userId: string; tokenHint: string; createdAt: string; lastUsedAt: string }

/**
 * Token theo dự án (cần quản trị). Không phải admin / chưa đăng nhập -> `admin: false`, trang ẩn nút cấp token.
 * Lỗi kết nối backend thì ném lỗi như các loader khác.
 */
export async function loadProjectTokens(req: Request, projectId: string): Promise<{ admin: boolean; tokens: ProjectTokenInfo[] }> {
  const r = await backendGet<ProjectTokenInfo[]>(req, `/api/projects/${encodeURIComponent(projectId)}/tokens`);
  if (r.ok && Array.isArray(r.body)) return { admin: true, tokens: r.body };
  if ([401, 403, 404, 429, 503].includes(r.status)) return { admin: false, tokens: [] };
  throw new Error(`backend trả HTTP ${r.status}: ${r.body.error ?? ''}`);
}

/** Một dòng trong trang xem công khai (không có id / HAR). */
export interface PublicBacklogItem { stt: number; project: string; title: string; type: string; team: string; status: string; statusLabel: string; hasImage: boolean }

/** Danh sách backlog rút gọn cho người vãng lai (API công khai, truyền nguyên bộ lọc từ query string). */
export async function loadPublicBacklog(req: Request): Promise<{ project: string; total: number; items: PublicBacklogItem[] }> {
  const allowed = ['project', 'team', 'type', 'status', 'q'];
  const params = new URLSearchParams();
  for (const k of allowed) if (typeof req.query[k] === 'string' && req.query[k]) params.set(k, req.query[k] as string);
  const r = await backendGet<{ project: string; total: number; items: PublicBacklogItem[] }>(req, `/api/public/backlog${params.size ? `?${params}` : ''}`);
  if (!r.ok) throw new Error(`backend trả HTTP ${r.status}: ${r.body.error ?? ''}`);
  return r.body;
}

export async function loadData(req: Request): Promise<Data> {
  const r = await backendGet<Data>(req, '/api/bootstrap');
  if (!r.ok) throw new Error(`backend trả HTTP ${r.status}: ${r.body.error ?? ''}`);
  return r.body;
}

/**
 * Lấy người dùng + nhật ký (cần đăng nhập quản trị). Trạng thái suy ra từ phản hồi của backend:
 * 503 `admin-setup` = chưa có admin; 401/403/429 = chưa đăng nhập; 200 = đã đăng nhập.
 */
export async function loadUsers(req: Request): Promise<UsersData> {
  const [users, audit] = await Promise.all([backendGet<PublicUser[]>(req, '/api/users'), backendGet<AuditEntry[]>(req, '/api/users/audit')]);
  if (users.ok) return { state: 'ok', users: users.body, audit: audit.ok ? audit.body : [] };
  if (users.body.code === 'admin-setup') return { state: 'disabled', users: [], audit: [] };
  return { state: 'locked', users: [], audit: [] };
}

/** Lấy cấu hình MCP / xác thực của backend. */
export async function loadMcpInfo(req: Request): Promise<McpInfo> {
  const info = await backendGet<McpInfo>(req, '/api/mcp-info');
  if (!info.ok) throw new Error(`backend trả HTTP ${info.status}`);
  return info.body;
}

/** Hồ sơ người đang đăng nhập; chưa đăng nhập (401/403/429) hoặc chưa có admin (503) -> null. */
export async function loadProfile(req: Request): Promise<Profile | null> {
  const r = await backendGet<Profile>(req, '/api/admin/me');
  return r.ok ? r.body : null;
}
