/**
 * Client gọi BACKEND qua HTTP (phía server của frontend).
 *
 * Frontend không đọc DB và không import code của backend: mọi dữ liệu đều đi qua API `/api/...`.
 * Cookie đăng nhập quản trị của trình duyệt được chuyển tiếp để backend nhận biết người dùng.
 */
import type { Request } from 'express';
import type { AuditEntry, Feedback, McpInfo, Project, PublicUser, Team } from './types.js';
import type { Data, UsersData } from './pages/index.js';

/** Địa chỉ backend (không có dấu / cuối). */
export const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/+$/, '');

/** Kết quả một lần gọi backend. */
interface BackendResponse<T> {
  status: number;
  ok: boolean;
  body: T & { code?: string; error?: string };
}

/**
 * Gọi `GET <BACKEND_URL><path>`, chuyển tiếp cookie của request và địa chỉ IP thật của người dùng
 * (để giới hạn tốc độ / khóa IP của backend tính đúng người).
 * @throws nếu không kết nối được backend
 */
export async function backendGet<T>(req: Request, path: string): Promise<BackendResponse<T>> {
  const headers: Record<string, string> = {
    'x-forwarded-for': req.ip || '',
    'x-forwarded-proto': req.protocol,
    'x-forwarded-host': req.get('host') || '',
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  const res = await fetch(BACKEND_URL + path, { headers, signal: AbortSignal.timeout(15000) });
  const body = (await res.json().catch(() => ({}))) as BackendResponse<T>['body'];
  return { status: res.status, ok: res.ok, body };
}

/** Lấy dự án, team, backlog; ném lỗi nếu backend trả lỗi. */
export async function loadData(req: Request): Promise<Data> {
  const [projects, teams, feedbacks] = await Promise.all([
    backendGet<Project[]>(req, '/api/projects'),
    backendGet<Team[]>(req, '/api/teams'),
    backendGet<Feedback[]>(req, '/api/feedbacks'),
  ]);
  for (const r of [projects, teams, feedbacks]) if (!r.ok) throw new Error(`backend trả HTTP ${r.status}: ${r.body.error ?? ''}`);
  return { projects: projects.body, teams: teams.body, feedbacks: feedbacks.body };
}

/**
 * Lấy người dùng + nhật ký (cần đăng nhập quản trị). Trạng thái suy ra từ phản hồi của backend:
 * 503 `admin-setup` = chưa có admin; 401/403/429 = chưa đăng nhập; 200 = đã đăng nhập.
 */
export async function loadUsers(req: Request): Promise<UsersData> {
  const users = await backendGet<PublicUser[]>(req, '/api/users');
  if (users.ok) {
    const audit = await backendGet<AuditEntry[]>(req, '/api/users/audit');
    return { state: 'ok', users: users.body, audit: audit.ok ? audit.body : [] };
  }
  if (users.body.code === 'admin-setup') return { state: 'disabled', users: [], audit: [] };
  return { state: 'locked', users: [], audit: [] };
}

/** Lấy cấu hình MCP / xác thực của backend. */
export async function loadMcpInfo(req: Request): Promise<McpInfo> {
  const info = await backendGet<McpInfo>(req, '/api/mcp-info');
  if (!info.ok) throw new Error(`backend trả HTTP ${info.status}`);
  return info.body;
}
