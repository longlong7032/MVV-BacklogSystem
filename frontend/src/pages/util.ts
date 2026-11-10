/**
 * Tiện ích dùng chung cho các trang render phía server: định dạng, query string, tiến độ, danh sách <option>
 * và các helper Handlebars (fmtDate, fmtSize, timeAgo, dateTime, json, eq).
 */
import type { Feedback, FeedbackStatus } from '../types.js';

/** Một dòng <option> cho dropdown. */
export interface OptionItem {
  value: string;
  label: string;
  selected?: boolean;
}

/** Nhãn và màu (Tailwind) của từng trạng thái. */
export const STATUSES: Record<FeedbackStatus, { label: string; badge: string; dot: string }> = {
  todo: { label: 'Chưa làm', badge: 'border-slate-300 bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
  doing: { label: 'Đang làm', badge: 'border-amber-300 bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
  done: { label: 'Đã hoàn thành', badge: 'border-emerald-300 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
};
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
  /** Class của liên kết trên sidebar: tab đang mở được tô sáng. */
  navClass: (tab: unknown, key: unknown) =>
    tab === key ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white',
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
