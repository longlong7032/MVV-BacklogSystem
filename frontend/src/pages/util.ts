/**
 * Tiện ích dùng chung cho các trang render phía server: định dạng, query string, tiến độ, danh sách <option>
 * và các helper Handlebars (fmtDate, fmtSize, timeAgo, dateTime, json, eq).
 */
import type { DocumentStatus, Feedback, FeedbackStatus } from '../types.js';

/** Một dòng <option> cho dropdown. */
export interface OptionItem {
  value: string;
  label: string;
  selected?: boolean;
}

/**
 * Nhãn và màu của từng trạng thái — dùng class của DaisyUI (badge / progress) và màu theme
 * (base-content, warning, success) nên tự đổi theo giao diện sáng/tối.
 */
export const STATUSES: Record<FeedbackStatus, { label: string; badge: string; dot: string; progress: string; select: string }> = {
  todo: { label: 'Chưa làm', badge: 'badge-ghost', dot: 'bg-base-content/40', progress: '', select: '' },
  doing: { label: 'Đang làm', badge: 'badge-warning badge-outline', dot: 'bg-warning', progress: 'progress-warning', select: 'select-warning' },
  done: { label: 'Đã hoàn thành', badge: 'badge-success badge-outline', dot: 'bg-success', progress: 'progress-success', select: 'select-success' },
};

/**
 * Bảng màu ngữ nghĩa dùng chung cho thẻ thống kê, badge, chấm màu.
 * View-model chỉ chọn `tone`, không tự ghép class màu → đổi theme / màu chỉ sửa ở đây.
 */
export type Tone = 'primary' | 'neutral' | 'info' | 'success' | 'warning' | 'error';
export const TONES: Record<Tone, { dot: string; badge: string; progress: string }> = {
  primary: { dot: 'bg-primary', badge: 'badge-primary badge-outline', progress: 'progress-primary' },
  neutral: { dot: 'bg-base-content/40', badge: 'badge-ghost', progress: '' },
  info: { dot: 'bg-info', badge: 'badge-info badge-outline', progress: 'progress-info' },
  success: { dot: 'bg-success', badge: 'badge-success badge-outline', progress: 'progress-success' },
  warning: { dot: 'bg-warning', badge: 'badge-warning badge-outline', progress: 'progress-warning' },
  error: { dot: 'bg-error', badge: 'badge-error badge-outline', progress: 'progress-error' },
};
/** Nhãn + màu trạng thái tài liệu PTYC. */
export const DOC_STATUSES: Record<DocumentStatus, { label: string; badge: string }> = {
  draft: { label: 'Nháp', badge: 'badge-ghost' },
  review: { label: 'Chờ duyệt', badge: 'badge-warning badge-outline' },
  approved: { label: 'Đã duyệt', badge: 'badge-success badge-outline' },
};
export const DOC_STATUS_KEYS = Object.keys(DOC_STATUSES) as DocumentStatus[];

/** Định dạng số tiền VND, vd 1.000.000. */
export const money = (n: number): string => new Intl.NumberFormat('vi-VN').format(n || 0);

/** Thứ tự hiển thị của các trạng thái. */
export const STATUS_KEYS = Object.keys(STATUSES) as FeedbackStatus[];

/** URL có phải http(s) không (chỉ khi đó mới render thành link bấm được). */
export const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

/** Định dạng ngày theo locale Việt Nam; rỗng nếu không có. */
export const fmtDate = (iso: unknown): string => (typeof iso === 'string' && iso ? new Date(iso).toLocaleDateString('vi-VN') : '');

/** Định dạng ngày giờ theo locale Việt Nam. */
export const dateTime = (iso: unknown): string => (typeof iso === 'string' && iso ? new Date(iso).toLocaleString('vi-VN') : '');

/** Định dạng dung lượng file (KB/MB). */
export const fmtSize = (bytes: unknown): string => {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
};

/** Thời gian tương đối ("5 phút trước"); quá 30 ngày thì hiện ngày. */
export const timeAgo = (iso: unknown): string => {
  if (typeof iso !== 'string' || !iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} giờ trước`;
  const day = Math.floor(hour / 24);
  return day < 30 ? `${day} ngày trước` : fmtDate(iso);
};

/** Helper Handlebars để các trang đăng ký một lần (xem server.ts). */
export const HELPERS: Record<string, (...args: any[]) => unknown> = {
  fmtDate: (iso: unknown) => fmtDate(iso),
  dateTime: (iso: unknown) => dateTime(iso),
  fmtSize: (bytes: unknown) => fmtSize(bytes),
  timeAgo: (iso: unknown) => timeAgo(iso),
  /** Chuỗi JSON để nhúng vào thuộc tính data-* (Handlebars tự escape khi in ra). */
  json: (value: unknown) => JSON.stringify(value),
  eq: (a: unknown, b: unknown) => a === b,
  /** Class của liên kết trên sidebar (DaisyUI `menu`): tab đang mở có class `active`. */
  navClass: (tab: unknown, key: unknown) => (tab === key ? 'active' : ''),
};

/** So sánh tên theo locale tiếng Việt (dùng để sắp xếp). */
export const byName = <T extends { name: string }>(list: T[]): T[] => [...list].sort((a, b) => a.name.localeCompare(b.name, 'vi'));

/** Đếm số backlog theo từng trạng thái. */
export const countByStatus = (list: Feedback[]): Record<FeedbackStatus, number> => {
  const counts: Record<FeedbackStatus, number> = { todo: 0, doing: 0, done: 0 };
  for (const f of list) counts[f.status] = (counts[f.status] || 0) + 1;
  return counts;
};

/** Dữ liệu cho partial `progress` (thanh tiến độ % hoàn thành kèm số lượng). */
export const makeProgress = (counts: Record<FeedbackStatus, number>, total: number, emptyText = 'Chưa có backlog') => ({
  empty: !total,
  emptyText,
  pct: total ? Math.round((counts.done / total) * 100) : 0,
  done: counts.done,
  total,
  todo: counts.todo,
  doing: counts.doing,
});

/**
 * Dựng danh sách `<option>` từ mảng dữ liệu.
 * @param selected giá trị đang chọn
 */
export const optionItems = <T>(list: T[], value: (x: T) => string, label: (x: T) => string, selected = ''): OptionItem[] =>
  list.map((x) => ({ value: value(x), label: label(x), selected: value(x) === selected }));

/** Dựng query string `?a=1&b=2` từ các tham số, bỏ qua giá trị rỗng/undefined. Trả '' nếu không có tham số. */
export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
};

/** Ép tham số query của Express về chuỗi đã cắt khoảng trắng. */
export const qstr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
