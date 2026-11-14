/**
 * Kiểu dữ liệu của API (DTO) dùng chung giữa backend, frontend và extension (frontend / extension giữ bản sao).
 * File chỉ chứa kiểu nên được import bằng `import type` và không sinh ra file .js.
 *
 * QUY ƯỚC: mọi bản ghi có `idPublic` (UUID v7) + `createdAt` + `updatedAt` (ISO-8601).
 *  - `idPrivate` (khóa nội bộ trong DB) KHÔNG BAO GIỜ xuất hiện trong API.
 *  - Bản ghi đã xóa mềm (`deletedAt`) không được trả về, nên không có trường `deletedAt` trong DTO.
 *  - Tham chiếu tới bản ghi khác (`projectId`, `teamId`, `assigneeId`, ...) chứa `idPublic` của bản ghi đó;
 *    chuỗi rỗng '' = không có.
 *  - Ngày (không có giờ) dạng 'YYYY-MM-DD' hoặc '' nếu chưa đặt.
 */

/** Trạng thái xử lý của một backlog: chưa làm / đang làm / đã hoàn thành. */
export type FeedbackStatus = 'todo' | 'doing' | 'done';

/** Quyền của người dùng: chỉ đọc, đọc + ghi, hoặc quản trị (ghi + quản lý người dùng). */
export type Role = 'read' | 'write' | 'admin';

/** Trạng thái tài liệu PTYC: nháp / chờ duyệt / đã duyệt. */
export type DocumentStatus = 'draft' | 'review' | 'approved';

/** Trường chung của mọi bản ghi trả ra API. */
export interface Entity {
  idPublic: string;
  createdAt: string;
  updatedAt: string;
}

/** Một vai trò trong dự án: tên + mô tả quyền hạn / trách nhiệm (dùng làm "Loại" của backlog). */
export interface ProjectRole {
  idPublic?: string;
  name: string;
  description: string;
}

/** Dự án — nhóm các backlog, đợt thanh toán, tài liệu. */
export interface Project extends Entity {
  /** Mã dự án viết hoa, có thể rỗng; không trùng giữa các dự án. */
  code: string;
  name: string;
  description: string;
  totalValue: number;
  startDate: string;
  deadline: string;
  /** idPublic của người dùng tham gia dự án. */
  memberIds: string[];
  roles: ProjectRole[];
  /** idPublic của backlog "xuất hóa đơn tổng" (nếu đã tạo). */
  invoiceFeedbackId: string;
}

/** Một đợt thanh toán của dự án. */
export interface PaymentRound extends Entity {
  projectId: string;
  stt: number;
  name: string;
  amount: number;
  note: string;
  paidAt: string;
  /** Ảnh biên nhận `/uploads/...` hoặc ''. */
  image: string;
  paid: boolean;
  companyAccount: boolean;
  invoiceFeedbackId: string;
}

/** Team xử lý backlog. */
export interface Team extends Entity {
  name: string;
  /** Tên trưởng nhóm (không bắt buộc). */
  lead: string;
  description: string;
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
export interface Feedback extends Entity {
  projectId: string;
  /** Team đang xử lý; '' = chưa phân công. */
  teamId: string;
  /** Người xử lý; '' = chưa giao. */
  assigneeId: string;
  title: string;
  /** Loại — một vai trò của dự án, ví dụ "App customer", "Website admin". */
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
  /** Tên người cập nhật gần nhất qua MCP (nếu có). */
  updatedBy: string;
}

/** Nhân sự tối thiểu dùng để phân công (không có email / thông tin xác thực). */
export interface ProjectMember {
  idPublic: string;
  name: string;
  teamId: string;
  role: Role;
}

/** Người dùng trả cho trang quản trị: không có giá trị băm, chỉ giữ cờ hasToken / hasPassword. */
export interface PublicUser extends Entity {
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
}

/** Một dòng nhật ký hoạt động quản trị. */
export interface AuditEntry extends Entity {
  actor: string;
  action: string;
  target: string;
}

/** Nhật ký thay đổi theo dự án (backlog, thanh toán, tài liệu PTYC). */
export interface ActivityEntry extends Entity {
  projectId: string;
  entityType: 'backlog' | 'ptyc' | 'payment' | 'project';
  /** idPublic của bản ghi bị thay đổi. */
  entityId: string;
  entityTitle: string;
  action: 'created' | 'updated' | 'status' | 'assigned' | 'deleted';
  actor: string;
  details: string[];
}

/** Một file tải lên (dùng trong tài liệu PTYC). */
export interface FileInfo {
  url: string;
  name: string;
  size: number;
  mime: string;
}

/** Một phiên bản của tài liệu PTYC. */
export interface DocumentVersion extends Entity {
  version: string;
  note: string;
  uploadedBy: string;
  file: FileInfo;
}

/** Tài liệu PTYC (phân tích yêu cầu) của dự án. */
export interface ProjectDocument extends Entity {
  projectId: string;
  title: string;
  /** Loại tài liệu, vd "Đặc tả nghiệp vụ", "Biên bản". */
  docType: string;
  status: DocumentStatus;
  note: string;
  /** Mới nhất trước. */
  versions: DocumentVersion[];
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
