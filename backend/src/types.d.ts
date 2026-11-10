/**
 * Các kiểu dữ liệu dùng chung giữa server (server.ts, lib/, mcp/), giao diện (client/) và extension.
 * File chỉ chứa kiểu (không có mã chạy) nên được import bằng `import type` và không sinh ra file .js.
 */

/** Trạng thái xử lý của một backlog: chưa làm / đang làm / đã hoàn thành. */
export type FeedbackStatus = 'todo' | 'doing' | 'done';

/** Quyền của người dùng: chỉ đọc, đọc + ghi, hoặc quản trị (ghi + quản lý người dùng). */
export type Role = 'read' | 'write' | 'admin';

/** Dự án — nhóm các backlog. */
export interface Project {
  id: string;
  /** Mã dự án viết hoa, có thể rỗng; không trùng giữa các dự án. */
  code: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** Team xử lý backlog. */
export interface Team {
  id: string;
  name: string;
  /** Tên trưởng nhóm (không bắt buộc). */
  lead: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** Thông tin file HAR (network log) đính kèm một backlog. */
export interface HarInfo {
  /** Đường dẫn tải file, dạng `/uploads/<tên-file>`. */
  url: string;
  /** Tên file gốc do người dùng/extension đặt. */
  name: string;
  /** Dung lượng tính bằng byte. */
  size: number;
}

/** Một phần nội dung của backlog gồm văn bản và danh sách ảnh (mô tả lỗi, kết quả mong muốn). */
export interface FeedbackPart {
  text: string;
  /** Danh sách đường dẫn ảnh `/uploads/...`. */
  images: string[];
}

/** Một backlog (feedback) lỗi. */
export interface Feedback {
  id: string;
  projectId: string;
  /** Id team đang xử lý; chuỗi rỗng = chưa phân công. */
  teamId: string;
  title: string;
  /** Loại, ví dụ "App customer", "Website admin". */
  type: string;
  note: string;
  /** Số thứ tự tự tăng trong từng dự án. */
  stt: number;
  status: FeedbackStatus;
  /** Vị trí lỗi: URL trang và/hoặc một ảnh chụp. */
  location: { url: string; image: string };
  bug: FeedbackPart;
  expected: FeedbackPart;
  har: HarInfo | null;
  /** Thời điểm chuyển sang "done"; null nếu chưa xong. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Tên người cập nhật gần nhất qua MCP (nếu có). */
  updatedBy?: string;
}

/** Người dùng đầy đủ như lưu trong DB (có băm token/mật khẩu — KHÔNG bao giờ gửi ra ngoài). */
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  active: boolean;
  /** SHA-256 của token cá nhân; chuỗi rỗng nếu chưa có token. */
  tokenHash: string;
  /** Gợi ý hiển thị của token (vd "fbk_AbCd…wXyZ"). */
  tokenHint: string;
  tokenCreatedAt?: string | null;
  lastUsedAt?: string | null;
  /** Mật khẩu băm dạng `scrypt$<salt>$<hash>` (chỉ admin đăng nhập bằng mật khẩu). */
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
}

/** Người dùng khi trả cho giao diện: bỏ các giá trị băm, chỉ giữ cờ hasToken/hasPassword. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  active: boolean;
  hasToken: boolean;
  hasPassword: boolean;
  tokenHint: string;
  tokenCreatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Một dòng nhật ký hoạt động quản trị. */
export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string;
}

/** Phiên đăng nhập quản trị bằng email + mật khẩu. */
export interface Session {
  userId: string;
  /** Thời điểm hết hạn (ms từ epoch). */
  exp: number;
}

/** Toàn bộ dữ liệu ứng dụng (một "tài liệu" JSON). */
export interface Database {
  projects: Project[];
  teams: Team[];
  users: User[];
  feedbacks: Feedback[];
  audit: AuditEntry[];
  /** Khóa = băm của token phiên. */
  sessions: Record<string, Session>;
}

/** Kết quả của GET /api/mcp-info. */
export interface McpInfo {
  enabled?: boolean;
  /** Có yêu cầu token cá nhân khi gọi /mcp hay không. */
  authRequired: boolean;
  readonly: boolean;
  /** Giới hạn dung lượng upload mỗi request (0 = không giới hạn). */
  maxUploadBytes?: number;
}

/** Cấu trúc HAR tối thiểu mà extension và MCP cần dùng. */
export interface HarEntry {
  startedDateTime: string;
  time: number;
  _resourceType?: string;
  request: {
    method: string;
    url: string;
    headers: HarHeader[];
    cookies?: HarCookie[];
    postData?: { mimeType?: string; text?: string };
    [key: string]: unknown;
  };
  response: {
    status: number;
    statusText: string;
    headers: HarHeader[];
    cookies?: HarCookie[];
    content?: { size?: number; mimeType?: string; text?: string; encoding?: string; comment?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
  [key: string]: unknown;
}

export interface Har {
  log: { entries: HarEntry[]; [key: string]: unknown };
}
