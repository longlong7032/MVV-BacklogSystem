/**
 * Giao diện Feedback backlog (CSR, không framework).
 *
 * Toàn bộ trạng thái nằm trong đối tượng `state`; mỗi "view" (dashboard, backlog, dự án, team, người dùng, MCP)
 * có hàm render riêng ghi HTML vào các phần tử đã có sẵn trong views/index.hbs.
 * File này được biên dịch từ TypeScript (client/app.ts) ra public/js/app.js bằng `npm run build:client`.
 */
import type { AuditEntry, Feedback, FeedbackPart, FeedbackStatus, HarInfo, McpInfo, Project, PublicUser, Team } from '../shared/types.js';

/* ---------- Kiểu dữ liệu ---------- */

/** Phần tử nhập liệu có `.value` (input, select hoặc textarea). */
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Tên các màn hình (khớp với hash `#/<view>`). */
type View = 'dashboard' | 'backlog' | 'projects' | 'teams' | 'users' | 'mcp';

/** Cách sắp xếp danh sách backlog. */
type SortKey = 'project' | 'newest' | 'updated';

/** Chế độ hiển thị backlog: bảng hoặc bảng Kanban. */
type ViewMode = 'list' | 'board';

/** Tên ba vùng nhận ảnh trong form backlog. */
type ZoneName = 'location' | 'bug' | 'expected';

/** Trạng thái tải danh sách người dùng: ok / disabled (chưa có admin) / locked (cần đăng nhập) / error. */
type UsersStatus = '' | 'ok' | 'disabled' | 'locked' | 'error';

/** Một vùng ảnh trong form: ảnh đã lưu trên server, file mới chọn và danh sách ảnh sẽ xóa khi lưu. */
interface Zone {
  /** Cho phép nhiều ảnh (false = chỉ một ảnh). */
  multi: boolean;
  /** URL các ảnh đã có trên server. */
  existing: string[];
  /** File mới người dùng vừa thêm (chưa tải lên). */
  files: File[];
  /** URL các ảnh đã có mà người dùng bấm xóa (gửi lên server khi lưu). */
  removed: string[];
}

/** Trạng thái toàn cục của giao diện. */
interface AppState {
  view: View;
  items: Feedback[];
  projects: Project[];
  teams: Team[];
  /** Id team đang lọc ('none' = chưa phân công). */
  team: string;
  /** Loại đang lọc ('none' = chưa phân loại). */
  type: string;
  /** Đã tải xong dự án / team / backlog lần đầu. */
  loaded: boolean;
  /** Panel lọc nâng cao đang mở. */
  filtersOpen: boolean;
  sort: SortKey;
  mode: ViewMode;
  page: number;
  /** Khóa của bộ lọc lần render trước, để biết khi nào cần về trang 1. */
  filterKey: string;
  teamQuery: string;
  editingTeam: Team | null;
  teamFromForm: boolean;
  users: PublicUser[];
  audit: AuditEntry[];
  usersStatus: UsersStatus;
  usersMessage: string;
  userQuery: string;
  editingUser: PublicUser | null;
  /** Id dự án đang lọc. */
  project: string;
  /** Trạng thái đang lọc ('' = tất cả). */
  status: FeedbackStatus | '';
  query: string;
  projectQuery: string;
  /** Backlog đang sửa (null = thêm mới). */
  editing: Feedback | null;
  /** Dự án đang sửa (null = thêm mới). */
  editingProject: Project | null;
  /** Form dự án được mở từ form backlog ("+ Dự án mới"). */
  projectFromForm: boolean;
  /** Vùng nhận ảnh khi dán (Ctrl+V). */
  activeZone: ZoneName;
}

/** Lỗi trả về từ API quản trị, kèm mã lỗi (`admin-auth`, `admin-setup`, ...). */
type AdminError = Error & { code?: string };

/** Bộ cấu hình cho một tab trong trang hướng dẫn MCP. */
interface McpTab {
  label: string;
  hint: string;
  code: string;
}

/* ---------- DOM helpers ---------- */

/**
 * Tìm một phần tử theo CSS selector; ném lỗi nếu không có (khung trang luôn phải có đủ phần tử).
 * @param T kiểu phần tử mong muốn, mặc định HTMLElement
 */
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Không tìm thấy phần tử ${sel}`);
  return el;
};

/** Tìm tất cả phần tử khớp selector, trả về mảng thật (để dùng map/filter). */
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];

/** Đọc thuộc tính `data-*` của phần tử; thiếu -> chuỗi rỗng (thay cho `string | undefined`). */
const data = (el: HTMLElement, key: string): string => el.dataset[key] ?? '';

/** Giá trị hiện tại của ô nhập đã phát sinh sự kiện `e`. */
const fieldValue = (e: Event): string => (e.target as Field).value;

/** Tìm phần tử gần nhất (từ chính phần tử đích của sự kiện đi lên) khớp selector; không có -> null. */
const closest = <T extends HTMLElement = HTMLElement>(e: Event, sel: string): T | null => (e.target as HTMLElement).closest<T>(sel);

/** Lấy thông điệp từ giá trị bắt được trong `catch` (kiểu `unknown`). */
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ---------- Hằng số ---------- */

/** Số ảnh tối đa mỗi vùng ảnh (khớp giới hạn của server). */
const MAX_IMAGES = 10;
/** Class đánh dấu vùng ảnh đang nhận Ctrl+V. */
const ZONE_ACTIVE = ['border-indigo-300', 'bg-indigo-50/40'];
/** Class đánh dấu ô thả file khi đang kéo ảnh vào. */
const DROP_ACTIVE = ['border-indigo-500', 'bg-indigo-50'];
/** Class của tab sidebar đang chọn / không chọn. */
const TAB_ACTIVE = ['bg-slate-800', 'text-white'];
const TAB_IDLE = ['text-slate-300', 'hover:bg-slate-800/60', 'hover:text-white'];
/** Tên hiển thị của từng màn hình. */
const VIEWS: Record<View, string> = {
  dashboard: 'Dashboard',
  backlog: 'Backlog',
  projects: 'Dự án',
  teams: 'Team xử lý',
  users: 'Người dùng',
  mcp: 'Kết nối MCP',
};

/** Nhãn và màu (Tailwind) của từng trạng thái. */
const STATUSES: Record<FeedbackStatus, { label: string; badge: string; dot: string }> = {
  todo: { label: 'Chưa làm', badge: 'border-slate-300 bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
  doing: { label: 'Đang làm', badge: 'border-amber-300 bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
  done: { label: 'Đã hoàn thành', badge: 'border-emerald-300 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
};
/** Danh sách khóa trạng thái theo thứ tự hiển thị (todo -> doing -> done). */
const STATUS_KEYS = Object.keys(STATUSES) as FeedbackStatus[];

/** Trạng thái giao diện; khởi tạo rỗng, được điền sau khi `load()` lấy dữ liệu từ API. */
const state: AppState = {
  view: 'dashboard',
  items: [],
  projects: [],
  teams: [],
  team: '',
  type: '',
  loaded: false,
  filtersOpen: false,
  sort: 'project',
  mode: 'list',
  page: 1,
  filterKey: '',
  teamQuery: '',
  editingTeam: null,
  teamFromForm: false,
  users: [],
  audit: [],
  usersStatus: '',
  usersMessage: '',
  userQuery: '',
  editingUser: null,
  project: '',
  status: '',
  query: '',
  projectQuery: '',
  editing: null,
  editingProject: null,
  projectFromForm: false,
  activeZone: 'bug',
};

/** Dữ liệu ba vùng ảnh của form backlog. */
const zones: Record<ZoneName, Zone> = {
  location: { multi: false, existing: [], files: [], removed: [] },
  bug: { multi: true, existing: [], files: [], removed: [] },
  expected: { multi: true, existing: [], files: [], removed: [] },
};

/** Blob URL của từng File đang xem trước (để thu hồi khi không dùng nữa, tránh rò bộ nhớ). */
const objectUrls = new Map<File, string>();

/* ---------- Helpers ---------- */
/** Escape HTML để chèn an toàn dữ liệu người dùng vào chuỗi template (chống XSS). */
const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** URL có phải http(s) không (chỉ khi đó mới render thành link bấm được). */
const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);
/** Ký hiệu "không có dữ liệu" hiển thị trong ô bảng. */
const dash = '<span class="text-slate-400">—</span>';
/** Định dạng ngày theo locale Việt Nam; rỗng nếu không có. */
const fmtDate = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString('vi-VN') : '');

/** Lấy (hoặc tạo) blob URL để xem trước một file ảnh vừa chọn. */
const blobUrl = (file: File): string => {
  if (!objectUrls.has(file)) objectUrls.set(file, URL.createObjectURL(file));
  return objectUrls.get(file) as string;
};

/** Thu hồi blob URL của file khi không còn hiển thị. */
const releaseBlob = (file: File): void => {
  const url = objectUrls.get(file);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(file);
};

/** Tìm dự án theo id. */
const projectById = (id: string): Project | undefined => state.projects.find((p) => p.id === id);
/** Tên dự án theo id ("(không rõ)" nếu đã bị xóa). */
const projectName = (id: string): string => (projectById(id) || {}).name || '(không rõ)';
/** Nhãn dự án dạng "MÃ - Tên" (hoặc chỉ tên nếu không có mã). */
const projectLabel = (id: string): string => {
  const p = projectById(id);
  return p ? (p.code ? `${p.code} - ${p.name}` : p.name) : '(không rõ)';
};
/** Các loại mặc định luôn được gợi ý. */
const DEFAULT_TYPES = ['App customer', 'Website admin'];
/** Danh sách loại: mặc định + các loại đã dùng (không phân biệt hoa thường), sắp xếp theo tên. */
const typeList = (): string[] => {
  const seen = new Map();
  [...DEFAULT_TYPES, ...state.items.map((f) => f.type)].filter(Boolean).forEach((t) => {
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'vi'));
};
/** Dự án sắp xếp theo tên (locale tiếng Việt). */
const sortedProjects = (): Project[] => [...state.projects].sort((a, b) => a.name.localeCompare(b.name, 'vi'));

/** Tìm team theo id. */
const teamById = (id: string): Team | undefined => state.teams.find((t) => t.id === id);
/** Team sắp xếp theo tên. */
const sortedTeams = (): Team[] => [...state.teams].sort((a, b) => a.name.localeCompare(b.name, 'vi'));

/** STT kế tiếp trong dự án (chỉ dùng để gợi ý trên form; server mới là nơi cấp STT thật). */
const nextStt = (projectId: string): number =>
  state.items.filter((f) => f.projectId === projectId).reduce((max, f) => Math.max(max, f.stt), 0) + 1;

/** Đếm số backlog theo từng trạng thái. */
const countByStatus = (list: Feedback[]): Record<FeedbackStatus, number> => {
  const counts = { todo: 0, doing: 0, done: 0 };
  list.forEach((f) => (counts[f.status] = (counts[f.status] || 0) + 1));
  return counts;
};

/** Gọi API và trả JSON; ném `Error` với thông điệp thân thiện khi server báo lỗi (kể cả 413 do vượt dung lượng). */
async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 413) {
    throw new Error('Dung lượng tải lên quá lớn (tối đa khoảng 4MB mỗi lần lưu). Hãy bớt ảnh hoặc dùng ảnh nhỏ hơn.');
  }
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra, vui lòng thử lại.');
  return data;
}

/** Tạo tuỳ chọn fetch gửi body JSON. */
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* ---------- Render bảng backlog ---------- */
/** Ảnh thu nhỏ bấm để phóng to (lightbox). */
const thumb = (src: string): string =>
  `<img src="${esc(src)}" data-zoom="${esc(src)}" alt="" loading="lazy"
    class="h-20 w-20 cursor-zoom-in rounded border border-slate-200 object-cover">`;

/** Khối ảnh thu nhỏ; rỗng nếu không có ảnh. */
const imagesBlock = (images: string[] | undefined): string =>
  images && images.length ? `<div class="mt-2 flex flex-wrap gap-2">${images.map(thumb).join('')}</div>` : '';

/** Đoạn văn bản tối đa 4 dòng (đầy đủ trong tooltip). */
const textBlock = (text: string): string =>
  text ? `<p class="line-clamp-4 whitespace-pre-wrap break-words" title="${esc(text)}">${esc(text)}</p>` : '';

/** Ô "mô tả lỗi" / "kết quả mong muốn": văn bản + ảnh, hoặc dấu gạch nếu trống. */
const contentCell = (part: FeedbackPart): string =>
  textBlock(part.text) || part.images.length ? textBlock(part.text) + imagesBlock(part.images) : dash;

/** Định dạng dung lượng file (KB/MB). */
const fmtSize = (bytes: number): string =>
  bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';

/** Nút tải file HAR đính kèm. */
const harLink = (har: HarInfo | null): string =>
  har
    ? `<a href="${esc(har.url)}" download="${esc(har.name)}" title="Tải file HAR (mở bằng DevTools > Network > Import)"
         class="mt-2 inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
         <span aria-hidden="true">⇩</span> HAR · ${fmtSize(har.size || 0)}</a>`
    : '';

/** Ô "vị trí lỗi": link URL, ảnh chụp và file HAR. */
const locationCell = (location: Feedback['location'], har: HarInfo | null): string => {
  if (!location.url && !location.image && !har) return dash;
  const link = !location.url
    ? ''
    : isHttp(location.url)
      ? `<a href="${esc(location.url)}" target="_blank" rel="noopener noreferrer"
         class="break-all text-indigo-600 underline hover:text-indigo-800">${esc(location.url)}</a>`
      : `<span class="break-all">${esc(location.url)}</span>`;
  const image = location.image ? `<div class="mt-2">${thumb(location.image)}</div>` : '';
  return link + image + (har ? `<div>${harLink(har)}</div>` : '');
};

/** Các thẻ <option> trạng thái, chọn sẵn `selected`. */
const statusOptions = (selected: string): string =>
  STATUS_KEYS.map((k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${STATUSES[k].label}</option>`).join('');

/** Ô trạng thái: dropdown đổi nhanh + ngày hoàn thành. */
const statusCell = (f: Feedback): string => `
  <select data-status-id="${esc(f.id)}" aria-label="Trạng thái backlog #${f.stt}"
    class="w-full cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-200 ${STATUSES[f.status].badge}">
    ${statusOptions(f.status)}
  </select>
  ${f.status === 'done' && f.completedAt ? `<p class="mt-1 text-xs text-slate-400">Xong ${fmtDate(f.completedAt)}</p>` : ''}`;

/** Thời gian tương đối ("5 phút trước"); quá 30 ngày thì hiện ngày. */
const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} giờ trước`;
  const day = Math.floor(hour / 24);
  return day < 30 ? `${day} ngày trước` : fmtDate(iso);
};

/** Dropdown đổi nhanh team của một backlog. */
const teamSelect = (f: Feedback): string => `
  <select data-team-id="${esc(f.id)}" aria-label="Team xử lý backlog #${f.stt}"
    class="w-full cursor-pointer rounded-md border px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-200 ${
      f.teamId ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-dashed border-slate-300 bg-white text-slate-500'
    }">
    <option value="">Chưa phân công</option>
    ${sortedTeams()
      .map((t) => `<option value="${esc(t.id)}"${t.id === f.teamId ? ' selected' : ''}>${esc(t.name)}</option>`)
      .join('')}
  </select>`;

/** Ô team: dropdown + thời điểm / người cập nhật gần nhất. */
const teamCell = (f: Feedback): string =>
  teamSelect(f) +
  `<p class="mt-1 text-xs text-slate-400" title="${esc(new Date(f.updatedAt).toLocaleString('vi-VN'))}">Cập nhật ${timeAgo(f.updatedAt)}${f.updatedBy ? ` · ${esc(f.updatedBy)}` : ''}</p>`;

/** Nhãn loại backlog. */
const typeChip = (type: string): string =>
  type
    ? `<span class="inline-block max-w-full truncate rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700" title="${esc(type)}">${esc(type)}</span>`
    : dash;

/** Ô dự án: mã, tên và STT. */
const projectCell = (f: Feedback): string => {
  const p = projectById(f.projectId);
  return `
    ${p && p.code ? `<span class="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700">${esc(p.code)}</span>` : ''}
    <p class="break-words font-medium ${f.status === 'done' ? 'text-slate-500' : 'text-slate-900'}">${esc(p ? p.name : '(không rõ)')}</p>
    <p class="mt-0.5 text-xs text-slate-400">STT ${f.stt}</p>`;
};

/** HTML một dòng của bảng backlog. */
const rowHtml = (f: Feedback): string => `
  <tr class="align-top hover:bg-slate-50 ${f.status === 'done' ? 'text-slate-500' : ''}">
    <td class="px-3 py-3">${projectCell(f)}</td>
    <td class="px-3 py-3">${typeChip(f.type)}</td>
    <td class="px-3 py-3">${teamCell(f)}</td>
    <td class="px-3 py-3">${statusCell(f)}</td>
    <td class="break-words px-3 py-3 font-medium ${f.status === 'done' ? 'text-slate-500' : 'text-slate-900'}">${esc(f.title) || dash}</td>
    <td class="px-3 py-3">${locationCell(f.location, f.har)}</td>
    <td class="px-3 py-3">${contentCell(f.bug)}</td>
    <td class="px-3 py-3">${contentCell(f.expected)}</td>
    <td class="px-3 py-3 text-slate-600">${textBlock(f.note) || dash}</td>
    <td class="px-3 py-3">
      <div class="flex justify-end gap-1">
        <button type="button" data-act="edit" data-id="${esc(f.id)}"
          class="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Sửa</button>
        <button type="button" data-act="delete" data-id="${esc(f.id)}"
          class="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Xóa</button>
      </div>
    </td>
  </tr>`;

/** Lọc theo dự án, team, loại + từ khóa (chưa lọc trạng thái, để đếm số lượng mỗi trạng thái). */
const baseFiltered = (): Feedback[] => {
  const q = state.query.trim().toLowerCase();
  return state.items
    .filter((f) => !state.project || f.projectId === state.project)
    .filter((f) => !state.team || (state.team === 'none' ? !f.teamId : f.teamId === state.team))
    .filter((f) => !state.type || (state.type === 'none' ? !f.type : f.type.toLowerCase() === state.type.toLowerCase()))
    .filter((f) => {
      if (!q) return true;
      return [
        projectLabel(f.projectId),
        f.type,
        (teamById(f.teamId) || {}).name,
        f.title,
        f.location.url,
        f.bug.text,
        f.expected.text,
        f.note,
      ].some((s) =>
        String(s || '')
          .toLowerCase()
          .includes(q)
      );
    });
};

/** Vẽ lại dropdown lọc theo dự án. */
const renderProjectFilter = (): void => {
  if (state.loaded && state.project && !projectById(state.project)) state.project = '';
  $<Field>('#filterProject').innerHTML =
    '<option value="">Tất cả dự án</option>' +
    sortedProjects()
      .map((p) => `<option value="${esc(p.id)}"${p.id === state.project ? ' selected' : ''}>${esc(projectLabel(p.id))}</option>`)
      .join('');
};

/** Vẽ lại dropdown lọc theo loại. */
const renderTypeFilter = (): void => {
  if (state.loaded && state.type && state.type !== 'none' && !typeList().some((t) => t.toLowerCase() === state.type.toLowerCase()))
    state.type = '';
  $<Field>('#filterType').innerHTML =
    '<option value="">Tất cả loại</option><option value="none"' +
    (state.type === 'none' ? ' selected' : '') +
    '>Chưa phân loại</option>' +
    typeList()
      .map((t) => `<option value="${esc(t)}"${t.toLowerCase() === state.type.toLowerCase() ? ' selected' : ''}>${esc(t)}</option>`)
      .join('');
};

/** Vẽ lại dropdown lọc theo team. */
const renderTeamFilter = (): void => {
  if (state.loaded && state.team && state.team !== 'none' && !teamById(state.team)) state.team = '';
  $<Field>('#filterTeam').innerHTML =
    '<option value="">Tất cả team</option><option value="none"' +
    (state.team === 'none' ? ' selected' : '') +
    '>Chưa phân công</option>' +
    sortedTeams()
      .map((t) => `<option value="${esc(t.id)}"${t.id === state.team ? ' selected' : ''}>${esc(t.name)}</option>`)
      .join('');
};

/** Thẻ thống kê kiêm bộ lọc trạng thái. */
const renderStatusTabs = (counts: Record<FeedbackStatus, number>, total: number): void => {
  const card = (key: string, label: string, count: number, dot: string, bar: string): string => {
    const active = state.status === key;
    const pct = total ? Math.round((count / total) * 100) : 0;
    return `<button type="button" role="tab" aria-selected="${active}" data-status-filter="${key}"
      class="rounded-lg border bg-white p-4 text-left shadow-sm transition hover:shadow ${
        active ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-slate-200'
      }">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-slate-500">${label}</span>
        <span class="h-2.5 w-2.5 rounded-full ${dot}"></span>
      </div>
      <p class="mt-1 text-2xl font-semibold text-slate-900">${count}</p>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div class="h-full rounded-full ${bar}" style="width:${pct}%"></div></div>
    </button>`;
  };
  $('#statusTabs').innerHTML =
    card('', 'Tất cả', total, 'bg-indigo-500', 'bg-indigo-500') +
    STATUS_KEYS.map((k) => card(k, STATUSES[k].label, counts[k], STATUSES[k].dot, STATUSES[k].dot)).join('');
};

/* ---------- Kanban ---------- */
/** Thẻ backlog trên bảng Kanban (kéo thả được). */
const boardCard = (f: Feedback): string => {
  const image = f.bug.images[0] || f.location.image;
  return `
    <article draggable="true" data-card="${esc(f.id)}"
      class="cursor-grab rounded-md border border-slate-200 bg-white p-3 shadow-sm hover:shadow active:cursor-grabbing">
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="truncate font-medium text-slate-700">${esc(projectLabel(f.projectId))} · #${f.stt}</span>
        <button type="button" data-act="edit" data-id="${esc(f.id)}" class="shrink-0 font-medium text-indigo-600 hover:text-indigo-800">Sửa</button>
      </div>
      ${f.type ? `<span class="mt-2 inline-block max-w-full truncate rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700">${esc(f.type)}</span>` : ''}
      ${f.title ? `<p class="mt-2 line-clamp-2 break-words text-sm font-semibold text-slate-900">${esc(f.title)}</p>` : ''}
      <p class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-slate-700">${esc(f.bug.text) || '<span class="text-slate-400">(không có mô tả)</span>'}</p>
      ${image ? `<img src="${esc(image)}" data-zoom="${esc(image)}" alt="" loading="lazy" class="mt-2 h-24 w-full cursor-zoom-in rounded border border-slate-200 object-cover">` : ''}
      <div class="mt-3 flex items-center justify-between gap-2 text-xs text-slate-500">
        ${
          teamById(f.teamId)
            ? `<span class="truncate rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700">${esc(teamById(f.teamId)?.name)}</span>`
            : '<span class="text-slate-400">Chưa phân công</span>'
        }
        <span class="shrink-0">${timeAgo(f.updatedAt)}</span>
      </div>
    </article>`;
};

/** Vẽ bảng Kanban: một cột cho mỗi trạng thái. */
const renderBoard = (list: Feedback[]): void => {
  $('#boardWrap').innerHTML = STATUS_KEYS.map((k) => {
    const col = list.filter((f) => f.status === k);
    return `
      <section data-col="${k}" class="min-h-[12rem] rounded-lg border border-slate-200 bg-slate-100/70 p-3">
        <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <span class="h-2.5 w-2.5 rounded-full ${STATUSES[k].dot}"></span>${STATUSES[k].label}
          <span class="rounded-full bg-white px-2 text-xs font-medium text-slate-500">${col.length}</span>
        </h3>
        <div class="space-y-3">${col.map(boardCard).join('') || '<p class="py-6 text-center text-xs text-slate-400">Kéo thả backlog vào đây</p>'}</div>
      </section>`;
  }).join('');
};

/** Các hàm so sánh tương ứng với từng kiểu sắp xếp. */
const SORTERS: Record<SortKey, (a: Feedback, b: Feedback) => number> = {
  project: (a, b) => projectName(a.projectId).localeCompare(projectName(b.projectId), 'vi') || a.stt - b.stt,
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
};
/** Số backlog mỗi trang (chế độ bảng). */
const PAGE_SIZE = 20;

/** Vẽ thanh phân trang (chế độ Kanban chỉ hiện tổng số). */
const renderPager = (total: number, pages: number): void => {
  if (state.mode === 'board' || !total) {
    $('#pager').innerHTML = state.mode === 'board' && total ? `<span>${total} backlog</span>` : '';
    return;
  }
  const from = (state.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, state.page * PAGE_SIZE);
  const btn = (label: string, page: number, disabled: boolean): string =>
    `<button type="button" data-page="${page}" ${disabled ? 'disabled' : ''}
      class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">${label}</button>`;
  $('#pager').innerHTML = `
    <span>Hiển thị ${from}–${to} / ${total} backlog</span>
    <div class="flex items-center gap-2">
      ${btn('‹ Trước', state.page - 1, state.page <= 1)}
      <span class="px-1 text-slate-500">Trang ${state.page}/${pages}</span>
      ${btn('Sau ›', state.page + 1, state.page >= pages)}
    </div>`;
};

/** Cập nhật nút Bộ lọc (số lượng đang áp dụng), nút xóa lọc và các chip bộ lọc đang bật. */
const renderFilterBar = (): void => {
  const chips = [];
  if (state.project) chips.push(['project', 'Dự án', projectLabel(state.project)]);
  if (state.type) chips.push(['type', 'Loại', state.type === 'none' ? 'Chưa phân loại' : state.type]);
  if (state.team) chips.push(['team', 'Team', state.team === 'none' ? 'Chưa phân công' : (teamById(state.team) || {}).name || '']);
  if (state.status) chips.push(['status', 'Trạng thái', STATUSES[state.status].label]);

  const advanced = [state.project, state.type, state.team].filter(Boolean).length;
  const badge = $('#filterBadge');
  badge.textContent = String(advanced);
  badge.classList.toggle('hidden', !advanced);
  badge.classList.toggle('inline-flex', Boolean(advanced));

  const anyFilter = chips.length > 0 || Boolean(state.query.trim());
  $('#btnClearFilters').classList.toggle('hidden', !anyFilter);
  $('#btnClearFilters').classList.toggle('inline-flex', anyFilter);

  $('#filterPanel').classList.toggle('hidden', !state.filtersOpen);
  $('#filterPanel').classList.toggle('grid', state.filtersOpen);
  $('#btnFilters').setAttribute('aria-expanded', String(state.filtersOpen));
  $('#btnFilters').classList.toggle('border-indigo-500', state.filtersOpen);

  const box = $('#activeChips');
  box.classList.toggle('hidden', !chips.length);
  box.classList.toggle('flex', chips.length > 0);
  box.innerHTML = chips
    .map(
      ([
        key,
        label,
        value,
      ]) => `<span class="inline-flex max-w-full items-center gap-1 rounded-full bg-indigo-50 py-1 pl-3 pr-1 text-xs font-medium text-indigo-700">
        <span class="truncate">${esc(label)}: ${esc(value)}</span>
        <button type="button" data-clear="${key}" aria-label="Bỏ lọc ${esc(label)}"
          class="flex h-6 w-6 items-center justify-center rounded-full hover:bg-indigo-100">×</button>
      </span>`
    )
    .join('');
};

/** Vẽ lại toàn bộ màn hình backlog: bộ lọc, thẻ thống kê, bảng/Kanban và phân trang. */
const renderBacklog = (): void => {
  renderProjectFilter();
  renderTypeFilter();
  renderTeamFilter();
  $<Field>('#sortBy').value = state.sort;
  $$('[data-mode]').forEach((b) => {
    const on = data(b, 'mode') === state.mode;
    b.setAttribute('aria-selected', String(on));
    ['border-indigo-600', 'text-indigo-700'].forEach((c) => b.classList.toggle(c, on));
    ['border-transparent', 'text-slate-500', 'hover:text-slate-800'].forEach((c) => b.classList.toggle(c, !on));
  });
  renderFilterBar();

  const base = baseFiltered();
  renderStatusTabs(countByStatus(base), base.length);

  // Đổi bộ lọc / sắp xếp -> về trang 1
  const key = [state.project, state.type, state.team, state.status, state.query, state.sort].join('|');
  if (key !== state.filterKey) {
    state.filterKey = key;
    state.page = 1;
  }

  const list = base.filter((f) => !state.status || f.status === state.status).sort(SORTERS[state.sort]);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);

  let empty = 'Chưa có backlog nào. Chọn "Thêm backlog" để ghi nhận lỗi đầu tiên.';
  if (!state.projects.length) empty = 'Chưa có dự án nào. Hãy tạo dự án ở tab "Dự án" trước khi thêm backlog.';
  else if (state.items.length) empty = 'Không có backlog nào khớp với bộ lọc.';

  const board = state.mode === 'board';
  $('#tableWrap').classList.toggle('hidden', board);
  $('#boardWrap').classList.toggle('hidden', !board);
  $('#boardWrap').classList.toggle('grid', board);

  if (board) renderBoard(list);
  else {
    const pageItems = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    $('#rows').innerHTML = pageItems.length
      ? pageItems.map(rowHtml).join('')
      : `<tr><td colspan="10" class="px-3 py-12 text-center text-slate-500">${esc(empty)}</td></tr>`;
  }
  renderPager(list.length, pages);
  $('#resultCount').textContent = `${list.length} backlog`;
};

/* ---------- Render bảng dự án ---------- */
/** Thanh tiến độ (% hoàn thành) kèm số lượng theo trạng thái. */
const progressCell = (counts: Record<FeedbackStatus, number>, total: number, emptyText = 'Chưa có backlog'): string => {
  if (!total) return `<span class="text-slate-400">${emptyText}</span>`;
  const pct = Math.round((counts.done / total) * 100);
  return `
    <div class="flex items-center gap-2">
      <div class="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div class="h-full rounded-full bg-emerald-500" style="width:${pct}%"></div>
      </div>
      <span class="w-10 text-right text-xs font-medium text-slate-600">${pct}%</span>
    </div>
    <p class="mt-1 text-xs text-slate-500">
      ${counts.done}/${total} hoàn thành · ${counts.todo} chưa làm${counts.doing ? ` · ${counts.doing} đang làm` : ''}
    </p>`;
};

/** HTML một dòng của bảng dự án. */
const projectRowHtml = (p: Project): string => {
  const items = state.items.filter((f) => f.projectId === p.id);
  return `
    <tr class="align-top hover:bg-slate-50">
      <td class="px-3 py-3">
        ${p.code ? `<span class="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700">${esc(p.code)}</span>` : ''}
        <p class="break-words font-medium text-slate-900">${esc(p.name)}</p>
        ${p.description ? `<p class="mt-1 whitespace-pre-wrap break-words text-slate-500">${esc(p.description)}</p>` : ''}
      </td>
      <td class="px-3 py-3">${progressCell(countByStatus(items), items.length)}</td>
      <td class="px-3 py-3 text-slate-500">${fmtDate(p.createdAt)}</td>
      <td class="px-3 py-3">
        <div class="flex justify-end gap-1">
          <button type="button" data-pact="open" data-id="${esc(p.id)}"
            class="rounded px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">Xem backlog</button>
          <button type="button" data-pact="edit" data-id="${esc(p.id)}"
            class="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Sửa</button>
          <button type="button" data-pact="delete" data-id="${esc(p.id)}"
            class="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Xóa</button>
        </div>
      </td>
    </tr>`;
};

/** Vẽ bảng dự án (có lọc theo từ khóa). */
const renderProjects = (): void => {
  const q = state.projectQuery.trim().toLowerCase();
  const list = sortedProjects().filter(
    (p) =>
      !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
  );
  $('#projectSummary').textContent = `${state.projects.length} dự án`;
  $('#projectRows').innerHTML = list.length
    ? list.map(projectRowHtml).join('')
    : `<tr><td colspan="4" class="px-3 py-12 text-center text-slate-500">${
        state.projects.length ? 'Không có dự án nào khớp.' : 'Chưa có dự án nào. Chọn "Thêm dự án" để bắt đầu.'
      }</td></tr>`;
};

/* ---------- Render bảng team ---------- */
/** HTML một dòng của bảng team. */
const teamRowHtml = (t: Team): string => {
  const items = state.items.filter((f) => f.teamId === t.id);
  return `
    <tr class="align-top hover:bg-slate-50">
      <td class="px-3 py-3">
        <p class="break-words font-medium text-slate-900">${esc(t.name)}</p>
        ${t.description ? `<p class="mt-1 whitespace-pre-wrap break-words text-slate-500">${esc(t.description)}</p>` : ''}
      </td>
      <td class="break-words px-3 py-3 text-slate-700">${t.lead ? esc(t.lead) : dash}</td>
      <td class="px-3 py-3">${progressCell(countByStatus(items), items.length, 'Chưa được giao backlog')}</td>
      <td class="px-3 py-3">
        <div class="flex justify-end gap-1">
          <button type="button" data-tact="open" data-id="${esc(t.id)}"
            class="rounded px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">Xem backlog</button>
          <button type="button" data-tact="edit" data-id="${esc(t.id)}"
            class="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Sửa</button>
          <button type="button" data-tact="delete" data-id="${esc(t.id)}"
            class="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Xóa</button>
        </div>
      </td>
    </tr>`;
};

/** Vẽ bảng team (có lọc theo từ khóa). */
const renderTeams = (): void => {
  const q = state.teamQuery.trim().toLowerCase();
  const list = sortedTeams().filter(
    (t) =>
      !q ||
      [t.name, t.lead, t.description].some((s) =>
        String(s || '')
          .toLowerCase()
          .includes(q)
      )
  );
  $('#teamSummary').textContent = `${state.teams.length} team`;
  $('#teamRows').innerHTML = list.length
    ? list.map(teamRowHtml).join('')
    : `<tr><td colspan="4" class="px-3 py-12 text-center text-slate-500">${
        state.teams.length ? 'Không có team nào khớp.' : 'Chưa có team nào. Chọn "Thêm team" để bắt đầu.'
      }</td></tr>`;
};

/* ---------- Render dashboard ---------- */
/** Thẻ số liệu trên dashboard. */
const statCard = (label: string, value: string | number, sub: string, accent: string): string => `
  <div class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
    <div class="flex items-center justify-between">
      <p class="text-sm font-medium text-slate-500">${label}</p>
      <span class="h-2.5 w-2.5 rounded-full ${accent}"></span>
    </div>
    <p class="mt-2 text-3xl font-semibold text-slate-900">${value}</p>
    <p class="mt-1 text-xs text-slate-500">${sub}</p>
  </div>`;

/** Một dòng "khối lượng công việc" (theo team hoặc dự án) kèm thanh tiến độ. */
const loadRow = (name: string, items: Feedback[], href: string): string => {
  const counts = countByStatus(items);
  return `
    <a href="${href}" class="block px-5 py-3 hover:bg-slate-50">
      <div class="mb-1 flex items-center justify-between gap-3 text-sm">
        <span class="truncate font-medium text-slate-800">${esc(name)}</span>
        <span class="shrink-0 text-xs text-slate-500">${items.length} backlog · ${counts.todo} chưa làm · ${counts.doing} đang làm</span>
      </div>
      ${progressCell(counts, items.length)}
    </a>`;
};

/** Dòng thông báo khi danh sách trống. */
const emptyRow = (text: string): string => `<p class="px-5 py-8 text-center text-sm text-slate-500">${text}</p>`;

/** Vẽ dashboard: thẻ thống kê tổng quan, khối lượng theo team và theo dự án. */
const renderDashboard = (): void => {
  const counts = countByStatus(state.items);
  const total = state.items.length;
  const unassigned = state.items.filter((f) => !f.teamId && f.status !== 'done').length;
  $('#statCards').innerHTML =
    statCard('Tổng backlog', total, `${state.projects.length} dự án · ${state.teams.length} team`, 'bg-indigo-500') +
    statCard('Chưa làm', counts.todo, `${unassigned} chưa phân công team (chưa xong)`, 'bg-slate-400') +
    statCard('Đang làm', counts.doing, 'Đang được team xử lý', 'bg-amber-500') +
    statCard(
      'Đã hoàn thành',
      counts.done,
      total ? `${Math.round((counts.done / total) * 100)}% tổng backlog` : 'Chưa có backlog',
      'bg-emerald-500'
    );

  const teamRows = sortedTeams().map((t) =>
    loadRow(
      t.name,
      state.items.filter((f) => f.teamId === t.id),
      `#/backlog?team=${encodeURIComponent(t.id)}`
    )
  );
  const none = state.items.filter((f) => !f.teamId);
  if (none.length) teamRows.push(loadRow('Chưa phân công', none, '#/backlog?team=none'));
  $('#teamLoad').innerHTML = teamRows.length ? teamRows.join('') : emptyRow('Chưa có team nào.');

  const projectRows = sortedProjects().map((p) =>
    loadRow(
      projectLabel(p.id),
      state.items.filter((f) => f.projectId === p.id),
      `#/backlog?project=${encodeURIComponent(p.id)}`
    )
  );
  $('#projectLoad').innerHTML = projectRows.length ? projectRows.join('') : emptyRow('Chưa có dự án nào.');
};

/* ---------- Người dùng + token cá nhân (cần token quản trị viên) ---------- */
/** Nhãn tiếng Việt của quyền người dùng. */
const ROLE_LABEL: Record<string, string> = { read: 'Chỉ đọc', write: 'Đọc + ghi', admin: 'Quản trị viên' };
/** Khóa sessionStorage lưu token quản trị (mất khi đóng tab). */
const ADMIN_STORE = 'adminToken';
/** Truy cập an toàn token quản trị trong sessionStorage (trình duyệt chặn storage thì trả về rỗng). */
const adminKey = {
  get: () => {
    try {
      return sessionStorage.getItem(ADMIN_STORE) || '';
    } catch (e) {
      return '';
    }
  },
  set: (v: string): void => {
    try {
      if (v) sessionStorage.setItem(ADMIN_STORE, v);
      else sessionStorage.removeItem(ADMIN_STORE);
    } catch {
      // storage bị chặn (chế độ riêng tư...) -> bỏ qua, người dùng chỉ cần đăng nhập lại
    }
  },
};

/** Gọi API quản trị: tự đính kèm token; lỗi được ném kèm `code` để giao diện phân biệt (cần đăng nhập, bị khóa...). */
async function adminApi<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...(adminKey.get() ? { Authorization: 'Bearer ' + adminKey.get() } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Có lỗi xảy ra, vui lòng thử lại.'), { code: data.code });
  return data;
}

/** Chỉ hiện một trong các khung của trang Người dùng (đăng nhập / chưa có admin / nội dung). */
const showUsersPane = (pane: string): void => {
  ['usersLock', 'usersDisabled', 'usersContent'].forEach((id) => {
    $('#' + id).classList.toggle('hidden', id !== pane);
  });
};

/** Tải danh sách người dùng + nhật ký; phân loại lỗi vào `state.usersStatus` để chọn màn hình phù hợp. */
const loadUsers = async (): Promise<void> => {
  try {
    state.users = await adminApi('/api/users');
    state.usersStatus = 'ok';
    state.audit = await adminApi('/api/users/audit').catch(() => []);
  } catch (err) {
    const e = err as AdminError;
    if (e.code === 'admin-setup') state.usersStatus = 'disabled';
    else if (e.code === 'admin-auth' || e.code === 'admin-locked' || e.code === 'admin-forbidden') {
      const hadKey = Boolean(adminKey.get());
      state.usersStatus = 'locked';
      adminKey.set('');
      // Lần đầu vào (chưa nhập khóa) thì không báo lỗi; nhập sai mới báo
      state.usersMessage = e.code === 'admin-auth' ? (hadKey ? 'Phiên đăng nhập đã hết hạn hoặc token không đúng.' : '') : e.message;
    } else {
      state.usersStatus = 'error';
      state.usersMessage = e.message;
    }
  }
};

/** HTML một dòng của bảng người dùng. */
const userRowHtml = (u: PublicUser): string => {
  const team = teamById(u.teamId);
  const status = !u.hasToken
    ? ['Chưa có token', 'bg-slate-100 text-slate-600']
    : u.active
      ? ['Hoạt động', 'bg-emerald-50 text-emerald-700']
      : ['Vô hiệu hóa', 'bg-red-50 text-red-700'];
  return `
    <tr class="align-top hover:bg-slate-50">
      <td class="px-3 py-3">
        <p class="break-words font-medium text-slate-900">${esc(u.name)}</p>
        <p class="break-all text-slate-500">${esc(u.email)}</p>
      </td>
      <td class="px-3 py-3"><span class="rounded-md px-2 py-1 text-xs font-medium ${
        u.role === 'admin'
          ? 'bg-amber-50 text-amber-800'
          : u.role === 'write'
            ? 'bg-indigo-50 text-indigo-700'
            : 'bg-slate-100 text-slate-700'
      }">${ROLE_LABEL[u.role] || esc(u.role)}</span></td>
      <td class="px-3 py-3 text-slate-700">${team ? esc(team.name) : dash}</td>
      <td class="px-3 py-3">
        ${u.hasToken ? `<code class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">${esc(u.tokenHint)}</code>` : dash}
        <p class="mt-1 text-xs text-slate-400">${
          u.hasToken
            ? `Cấp ${fmtDate(u.tokenCreatedAt)} · ${u.lastUsedAt ? 'dùng ' + timeAgo(u.lastUsedAt) : 'chưa dùng'}`
            : 'Cần cấp token để kết nối'
        }</p>
      </td>
      <td class="px-3 py-3"><span class="rounded-full px-2.5 py-1 text-xs font-medium ${status[1]}">${status[0]}</span></td>
      <td class="px-3 py-3">
        <div class="flex flex-wrap justify-end gap-1">
          <button type="button" data-uact="edit" data-id="${esc(u.id)}" class="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Sửa</button>
          <button type="button" data-uact="token" data-id="${esc(u.id)}" class="rounded px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">${u.hasToken ? 'Cấp lại token' : 'Cấp token'}</button>
          ${u.hasToken ? `<button type="button" data-uact="revoke" data-id="${esc(u.id)}" class="rounded px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50">Thu hồi</button>` : ''}
          <button type="button" data-uact="delete" data-id="${esc(u.id)}" class="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Xóa</button>
        </div>
      </td>
    </tr>`;
};

/** Vẽ bảng người dùng (có lọc theo từ khóa). */
const renderUserTable = (): void => {
  const q = state.userQuery.trim().toLowerCase();
  const list = [...state.users]
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  $('#userSummary').textContent = `${state.users.length} người dùng`;
  $('#userRows').innerHTML = list.length
    ? list.map(userRowHtml).join('')
    : `<tr><td colspan="6" class="px-3 py-12 text-center text-slate-500">${
        state.users.length ? 'Không có người dùng nào khớp.' : 'Chưa có người dùng nào. Chọn "Thêm người dùng" để cấp token đầu tiên.'
      }</td></tr>`;
};

/** Vẽ bảng nhật ký hoạt động quản trị. */
const renderAudit = (): void => {
  $('#auditRows').innerHTML = state.audit.length
    ? state.audit
        .map(
          (a) => `<tr class="align-top">
            <td class="px-4 py-2 text-slate-500">${esc(new Date(a.at).toLocaleString('vi-VN'))}</td>
            <td class="px-4 py-2 font-medium text-slate-800">${esc(a.actor)}</td>
            <td class="px-4 py-2 text-slate-700">${esc(a.action)}</td>
            <td class="px-4 py-2 text-slate-700">${esc(a.target)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="px-4 py-6 text-center text-slate-500">Chưa có hoạt động nào.</td></tr>';
};

/** Vẽ trang Người dùng: tải dữ liệu rồi hiện đúng khung theo trạng thái đăng nhập. */
const renderUsers = async (): Promise<void> => {
  showUsersPane('');
  await loadUsers();
  if (state.view !== 'users') return;
  if (state.usersStatus === 'ok') {
    showUsersPane('usersContent');
    renderUserTable();
    renderAudit();
  } else if (state.usersStatus === 'disabled') {
    showUsersPane('usersDisabled');
  } else {
    showUsersPane('usersLock');
    setError($('#adminKeyError'), state.usersStatus === 'error' ? state.usersMessage : state.usersMessage || '');
    ($('#loginTokenFields').classList.contains('hidden') ? $<Field>('#adminEmail') : $<Field>('#adminKey')).focus();
  }
};

/** Mở form thêm/sửa người dùng. */
const openUserForm = (user: PublicUser | null = null): void => {
  state.editingUser = user;
  $<HTMLFormElement>('#userForm').reset();
  setError($('#userFormError'), '');
  $('#userModalTitle').textContent = user ? 'Sửa người dùng' : 'Thêm người dùng';
  $<HTMLButtonElement>('#btnSaveUser').textContent = user ? 'Lưu thay đổi' : 'Lưu & tạo token';
  $<Field>('#uName').value = user ? user.name : '';
  $<Field>('#uEmail').value = user ? user.email : '';
  $<Field>('#uRole').value = user ? user.role : 'read';
  $<Field>('#uTeam').innerHTML =
    '<option value="">— Không —</option>' +
    sortedTeams()
      .map((t) => `<option value="${esc(t.id)}"${user && t.id === user.teamId ? ' selected' : ''}>${esc(t.name)}</option>`)
      .join('');
  $<HTMLInputElement>('#uActive').checked = user ? user.active : true;
  $('#uActiveRow').classList.toggle('hidden', !user);
  $('#uActiveRow').classList.toggle('flex', Boolean(user));
  $('#uHint').classList.toggle('hidden', Boolean(user));
  setOpen(userModal, true);
  $<Field>('#uName').focus();
};

/** Đóng form người dùng. */
const closeUserForm = (): void => {
  setOpen(userModal, false);
  state.editingUser = null;
};

/** Hiện token vừa cấp (chỉ hiển thị một lần) kèm lệnh kết nối MCP. */
const showToken = (user: PublicUser, token: string): void => {
  $('#tokenUser').textContent = user.name;
  $('#tokenValue').textContent = token;
  $('#tokenCmd').textContent =
    `claude mcp add --transport http feedback-backlog ${location.origin}/mcp \\\n  --header "Authorization: Bearer ${token}"`;
  setOpen(tokenModal, true);
};

/** Đóng hộp token và xóa token khỏi DOM. */
const closeToken = (): void => {
  setOpen(tokenModal, false);
  $('#tokenValue').textContent = '';
  $('#tokenCmd').textContent = '';
  renderUsers();
};

/** Lưu người dùng (thêm mới sẽ hiện token vừa tạo). */
const submitUserForm = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const errorBox = $('#userFormError');
  setError(errorBox, '');

  const name = $<Field>('#uName').value.trim();
  const email = $<Field>('#uEmail').value.trim();
  if (!name) return (setError(errorBox, 'Vui lòng nhập họ tên.'), $<Field>('#uName').focus());
  if (!email) return (setError(errorBox, 'Vui lòng nhập email.'), $<Field>('#uEmail').focus());

  const btn = $<HTMLButtonElement>('#btnSaveUser');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang lưu...';
  try {
    const editing = state.editingUser;
    const body: Record<string, unknown> = { name, email, role: $<Field>('#uRole').value, teamId: $<Field>('#uTeam').value };
    if (editing) body.active = $<HTMLInputElement>('#uActive').checked;
    const result = await adminApi(editing ? `/api/users/${editing.id}` : '/api/users', jsonBody(editing ? 'PUT' : 'POST', body));
    closeUserForm();
    if (editing) await renderUsers();
    else showToken(result.user, result.token);
  } catch (err) {
    setError(errorBox, errorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

/** Xử lý các nút trên dòng người dùng: sửa, cấp/cấp lại token, thu hồi, xóa. */
const userAction = async (act: string, id: string): Promise<void> => {
  const user = state.users.find((u) => u.id === id);
  if (!user) return;
  try {
    if (act === 'edit') return openUserForm(user);
    if (act === 'token') {
      const ask = user.hasToken
        ? `Cấp lại token cho "${user.name}"?\n\nToken cũ sẽ mất hiệu lực ngay lập tức.`
        : `Cấp token cho "${user.name}"?`;
      if (!confirm(ask)) return;
      const result = await adminApi(`/api/users/${id}/token`, { method: 'POST' });
      return showToken(result.user, result.token);
    }
    if (act === 'revoke') {
      if (!confirm(`Thu hồi token của "${user.name}"?\n\nNgười này sẽ không kết nối MCP được nữa cho đến khi được cấp token mới.`)) return;
      await adminApi(`/api/users/${id}/token`, { method: 'DELETE' });
    }
    if (act === 'delete') {
      if (!confirm(`Xóa người dùng "${user.name}"? Token của họ sẽ mất hiệu lực.`)) return;
      await adminApi(`/api/users/${id}`, { method: 'DELETE' });
    }
    await renderUsers();
  } catch (err) {
    alert(errorMessage(err));
  }
};

/* ---------- Trang hướng dẫn MCP ---------- */
/** Trạng thái trang hướng dẫn MCP: thông tin server và tab đang chọn. */
const mcp: { info: McpInfo | null; tab: string } = { info: null, tab: 'claude-cli' };

/** Nội dung cấu hình MCP cho từng công cụ (Claude Code, Cursor, VS Code, Claude Desktop). */
const mcpTabs = (url: string, auth: boolean): Record<string, McpTab> => {
  const header = auth ? 'Authorization: Bearer <TOKEN>' : '';
  const json = (o: unknown): string => JSON.stringify(o, null, 2);
  const bearer = { Authorization: 'Bearer <TOKEN>' };
  return {
    'claude-cli': {
      label: 'Claude Code (CLI)',
      hint: 'Chạy một lần trong terminal. Thêm --scope user để dùng ở mọi project, hoặc --scope project để ghi vào .mcp.json và chia sẻ cho cả team.',
      code: `claude mcp add --transport http feedback-backlog ${url}${auth ? ` \\\n  --header "${header}"` : ''}`,
    },
    'claude-json': {
      label: '.mcp.json (Claude Code)',
      hint: 'Commit file này vào repo dự án để cả team dùng chung. Mỗi dev tự đặt biến môi trường BACKLOG_MCP_TOKEN, không ghi token vào file.',
      code: json({
        mcpServers: {
          'feedback-backlog': {
            type: 'http',
            url,
            ...(auth ? { headers: { Authorization: 'Bearer ${BACKLOG_MCP_TOKEN}' } } : {}),
          },
        },
      }),
    },
    cursor: {
      label: 'Cursor',
      hint: 'Thêm vào ~/.cursor/mcp.json (toàn cục) hoặc .cursor/mcp.json (theo project), rồi bật server trong Settings → MCP.',
      code: json({ mcpServers: { 'feedback-backlog': { url, ...(auth ? { headers: bearer } : {}) } } }),
    },
    vscode: {
      label: 'VS Code',
      hint: 'Tạo file .vscode/mcp.json trong project (cần GitHub Copilot Chat, chế độ Agent).',
      code: json({ servers: { 'feedback-backlog': { type: 'http', url, ...(auth ? { headers: bearer } : {}) } } }),
    },
    desktop: {
      label: 'Claude Desktop',
      hint: 'Claude Desktop chưa nối trực tiếp tới HTTP bằng file cấu hình nên dùng cầu nối mcp-remote (cần Node.js). Thêm vào claude_desktop_config.json rồi khởi động lại app.',
      code: json({
        mcpServers: {
          'feedback-backlog': { command: 'npx', args: ['-y', 'mcp-remote', url, ...(auth ? ['--header', header] : [])] },
        },
      }),
    },
  };
};

/** Chép văn bản vào clipboard (có phương án dự phòng cho trình duyệt/HTTP không hỗ trợ). */
const copyText = async (value: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // http / trình duyệt cũ không có clipboard API
    const ta = Object.assign(document.createElement('textarea'), { value });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
};

/** Vẽ trang hướng dẫn kết nối MCP. */
const renderMcp = async (): Promise<void> => {
  if (!mcp.info) {
    try {
      mcp.info = await api<McpInfo>('/api/mcp-info');
    } catch {
      // không lấy được thông tin -> giả định chế độ an toàn nhất (cần token, có ghi)
      mcp.info = { authRequired: true, readonly: false };
    }
  }
  const { authRequired, readonly } = mcp.info as McpInfo;
  const url = location.origin + '/mcp';
  const badge = (label: string, cls: string): string => `<span class="rounded-full px-2.5 py-1 ${cls}">${label}</span>`;

  $('#mcpUrl').textContent = url;
  $('#mcpBadges').innerHTML =
    badge(
      authRequired ? 'Token cá nhân' : 'Không cần token',
      authRequired ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
    ) + badge(readonly ? 'Chỉ đọc' : 'Đọc + ghi', readonly ? 'bg-slate-100 text-slate-700' : 'bg-indigo-50 text-indigo-700');

  $('#mcpTokenNote').innerHTML = authRequired
    ? 'Mỗi người dùng có <b>token cá nhân riêng</b>. Nhờ quản trị viên tạo tài khoản cho bạn ở trang <a href="#/users" class="font-medium text-indigo-600 hover:text-indigo-800">Người dùng</a> và gửi token (dạng <code class="rounded bg-slate-100 px-1.5 py-0.5 text-slate-800">fbk_…</code>). Thay <code class="rounded bg-slate-100 px-1.5 py-0.5 text-slate-800">&lt;TOKEN&gt;</code> trong các cấu hình bên dưới bằng token đó. Không chia sẻ token cho người khác hay commit vào repo — mất token thì xin cấp lại.'
    : 'Server đang chạy chế độ <b>DEV_NO_AUTH</b> (không cần token) — chỉ dùng để thử local.';

  const tabs = mcpTabs(url, authRequired);
  $('#mcpTabs').innerHTML = Object.entries(tabs)
    .map(
      ([key, t]) => `<button type="button" role="tab" data-mcp-tab="${key}" aria-selected="${key === mcp.tab}"
        class="-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
          key === mcp.tab ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'
        }">${t.label}</button>`
    )
    .join('');
  $('#mcpTabHint').textContent = tabs[mcp.tab].hint;
  $('#mcpCode').textContent = tabs[mcp.tab].code;

  $('#mcpCurl').textContent =
    `curl -s ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n` +
    (authRequired ? '  -H "Authorization: Bearer <TOKEN>" \\\n' : '') +
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
};

$('#viewMcp').addEventListener('click', async (e) => {
  const tab = closest(e, '[data-mcp-tab]');
  if (tab) {
    mcp.tab = data(tab, 'mcpTab') ?? 'claude-cli';
    return renderMcp();
  }
  const copy = closest(e, '[data-copy-target], [data-copy-prompt]');
  if (!copy) return;
  const value = data(copy, 'copyTarget')
    ? $(data(copy, 'copyTarget')).textContent
    : copy.parentElement?.querySelector('[data-prompt]')?.textContent;
  await copyText(value ?? '');
  const label = copy.textContent;
  copy.textContent = 'Đã chép ✓';
  setTimeout(() => (copy.textContent = label), 1500);
});

/* ---------- View (hash routing) ---------- */
/** Hàm vẽ tương ứng với từng màn hình. */
const RENDERERS: Record<View, () => void | Promise<void>> = {
  dashboard: () => renderDashboard(),
  backlog: () => renderBacklog(),
  projects: () => renderProjects(),
  teams: () => renderTeams(),
  users: () => renderUsers(),
  mcp: () => renderMcp(),
};
/** Vẽ lại màn hình hiện tại. */
const render = (): void | Promise<void> => RENDERERS[state.view]();
/** Đóng sidebar (giao diện di động). */
const closeSidebar = (): void => {
  $('#sidebar').classList.add('-translate-x-full');
  $('#sidebarBackdrop').classList.add('hidden');
};

/** Đọc hash `#/<view>?...` trên URL: chọn màn hình, áp bộ lọc (nếu có) rồi vẽ lại. */
const applyRoute = (): void => {
  const [path, query = ''] = location.hash.replace(/^#\//, '').split('?');
  state.view = path !== undefined && path in VIEWS ? (path as View) : 'dashboard';
  if (query) {
    const params = new URLSearchParams(query);
    if (state.view === 'backlog') {
      state.project = params.get('project') || '';
      state.team = params.get('team') || '';
      state.status = '';
      state.query = '';
      $<Field>('#filterQuery').value = '';
    }
    history.replaceState(null, '', '#/' + state.view);
  }
  Object.keys(VIEWS).forEach((v) => $('#view' + v[0].toUpperCase() + v.slice(1)).classList.toggle('hidden', state.view !== v));
  $('#pageTitle').textContent = VIEWS[state.view];
  $('#crumb').textContent = VIEWS[state.view];
  closeSidebar();
  $$('[data-tab]').forEach((a) => {
    const active = data(a, 'tab') === state.view;
    TAB_ACTIVE.forEach((c) => a.classList.toggle(c, active));
    TAB_IDLE.forEach((c) => a.classList.toggle(c, !active));
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  render();
};

/** Tải dự án, backlog, team từ API rồi vẽ lại; lỗi thì hiện thông báo ngay tại vùng nội dung. */
const load = async (): Promise<void> => {
  try {
    const [projects, items, teams] = await Promise.all([api('/api/projects'), api('/api/feedbacks'), api('/api/teams')]);
    state.projects = projects;
    state.items = items;
    state.teams = teams;
    state.loaded = true; // đã có dữ liệu -> mới được dọn bộ lọc trỏ tới mục không còn tồn tại
    render();
  } catch (err) {
    const message = esc(errorMessage(err) || 'Không tải được dữ liệu.');
    const target = ({ projects: '#projectRows', teams: '#teamRows', backlog: '#rows' } as Partial<Record<View, string>>)[state.view];
    if (target) {
      $(target).innerHTML = `<tr><td colspan="10" class="px-3 py-12 text-center text-red-600">${message}</td></tr>`;
    } else {
      $('#statCards').innerHTML = `<p class="text-sm text-red-600">${message}</p>`;
    }
  }
};

/* ---------- Đổi trạng thái nhanh ---------- */
/** Đổi trạng thái backlog (cập nhật giao diện ngay, hoàn tác nếu server báo lỗi). */
const changeStatus = async (id: string, status: string): Promise<void> => {
  const item = state.items.find((f) => f.id === id);
  if (!item || item.status === status) return;
  const previous = { status: item.status, completedAt: item.completedAt };
  Object.assign(item, { status, completedAt: status === 'done' ? new Date().toISOString() : null });
  render();
  try {
    Object.assign(item, await api(`/api/feedbacks/${id}/status`, jsonBody('PATCH', { status })));
  } catch (err) {
    Object.assign(item, previous);
    alert(errorMessage(err));
  }
  render();
};

/* ---------- Đổi team nhanh ---------- */
/** Giao backlog cho team (cập nhật giao diện ngay, hoàn tác nếu server báo lỗi). */
const changeTeam = async (id: string, teamId: string): Promise<void> => {
  const item = state.items.find((f) => f.id === id);
  if (!item || item.teamId === teamId) return;
  const previous = item.teamId;
  item.teamId = teamId;
  render();
  try {
    Object.assign(item, await api(`/api/feedbacks/${id}/team`, jsonBody('PATCH', { team_id: teamId })));
  } catch (err) {
    item.teamId = previous;
    alert(errorMessage(err));
  }
  render();
};

/* ---------- Vùng ảnh trong form ---------- */
/** Ảnh xem trước trong form kèm nút xóa. `kind`: ảnh đã lưu (existing) hay file mới (new). */
const previewHtml = (src: string, kind: 'existing' | 'new', index: number): string => `
  <div class="relative h-20 w-20">
    <img src="${esc(src)}" data-zoom="${esc(src)}" alt=""
      class="h-20 w-20 cursor-zoom-in rounded border border-slate-200 object-cover">
    <button type="button" data-remove="${kind}" data-index="${index}" aria-label="Xóa ảnh"
      class="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold leading-none text-white hover:bg-red-700">×</button>
  </div>`;

/** Vẽ lại ảnh xem trước của một vùng ảnh. */
const renderZone = (name: ZoneName): void => {
  const z = zones[name];
  $(`[data-preview="${name}"]`).innerHTML =
    z.existing.map((url, i) => previewHtml(url, 'existing', i)).join('') +
    z.files.map((file, i) => previewHtml(blobUrl(file), 'new', i)).join('');
};

/** Đặt lại một vùng ảnh (giải phóng blob, nạp ảnh đã có nếu đang sửa). */
const resetZone = (name: ZoneName, existing: string[] = []): void => {
  const z = zones[name];
  z.files.forEach(releaseBlob);
  z.existing = [...existing];
  z.files = [];
  z.removed = [];
  renderZone(name);
};

/** Thu nhỏ ảnh lớn (cạnh dài tối đa 2560px, nén WebP) để không vượt giới hạn tải lên ~4MB / lần của Vercel và tải nhanh hơn trên di động. */
const shrinkImage = async (file: File): Promise<File> => {
  if (file.type === 'image/gif' || file.size <= 700 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' });
  } catch {
    return file; // không nén được thì giữ nguyên
  }
};

/** Thêm ảnh vào một vùng (chọn file, kéo thả hoặc dán): thu nhỏ rồi giữ tối đa MAX_IMAGES; vùng một ảnh thì thay ảnh cũ. */
const addFiles = async (name: ZoneName, fileList: Iterable<File>): Promise<void> => {
  const z = zones[name];
  const picked = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!picked.length) return;
  const images = await Promise.all(picked.map(shrinkImage));

  if (!z.multi) {
    z.removed.push(...z.existing);
    z.existing = [];
    z.files.forEach(releaseBlob);
    z.files = [images[0]];
  } else {
    const room = MAX_IMAGES - z.existing.length - z.files.length;
    z.files.push(...images.slice(0, Math.max(room, 0)));
  }
  renderZone(name);
};

/** Đánh dấu vùng ảnh sẽ nhận ảnh khi dán (Ctrl+V). */
const setActiveZone = (name: ZoneName): void => {
  state.activeZone = name;
  $$('[data-zone]').forEach((section) => {
    const active = data(section, 'zone') === name;
    section.classList.toggle('border-transparent', !active);
    ZONE_ACTIVE.forEach((c) => section.classList.toggle(c, active));
  });
};

/* ---------- Modal chung ---------- */
/** Modal/phần tử có đang hiển thị không. */
const isOpen = (el: HTMLElement): boolean => !el.classList.contains('hidden');
/** Mở/đóng modal và khóa cuộn trang khi còn modal nào đang mở. */
const setOpen = (el: HTMLElement, open: boolean): void => {
  el.classList.toggle('hidden', !open);
  el.classList.toggle('flex', open);
  document.body.classList.toggle(
    'overflow-hidden',
    isOpen(modal) || isOpen(projectModal) || isOpen(teamModal) || isOpen(userModal) || isOpen(tokenModal)
  );
};
/** Hiện/ẩn thông báo lỗi trong một khung. */
const setError = (el: HTMLElement, message: string | undefined): void => {
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
};

/* ---------- Form backlog ---------- */
const modal = $('#modal');
/* Các modal và form; được lấy một lần khi tải trang. */
const form = $<HTMLFormElement>('#form');
const projectModal = $('#projectModal');
const projectForm = $<HTMLFormElement>('#projectForm');
const teamModal = $('#teamModal');
const userModal = $('#userModal');
const tokenModal = $('#tokenModal');
const teamForm = $<HTMLFormElement>('#teamForm');

/** Nạp danh sách team vào dropdown của form backlog. */
const fillTeamSelect = (selectedId: string): void => {
  $<Field>('#fTeam').innerHTML =
    '<option value="">— Chưa phân công —</option>' +
    sortedTeams()
      .map((t) => `<option value="${esc(t.id)}"${t.id === selectedId ? ' selected' : ''}>${esc(t.name)}</option>`)
      .join('');
};

/** Nạp danh sách dự án vào dropdown của form backlog. */
const fillProjectSelect = (selectedId: string): void => {
  const projects = sortedProjects();
  $<Field>('#fProject').innerHTML =
    '<option value="">— Chọn dự án —</option>' +
    projects
      .map((p) => `<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(projectLabel(p.id))}</option>`)
      .join('');
};

/** Gợi ý STT sẽ được cấp cho backlog đang nhập. */
const updateSttHint = (): void => {
  const hint = $('#sttHint');
  const projectId = $<Field>('#fProject').value;
  if (!state.projects.length) {
    hint.textContent = 'Chưa có dự án nào — chọn "+ Dự án mới" để tạo.';
    return;
  }
  if (state.editing) {
    hint.textContent =
      projectId && projectId !== state.editing.projectId
        ? `Đổi dự án: STT sẽ được cấp lại thành ${nextStt(projectId)}.`
        : `STT hiện tại: ${state.editing.stt}.`;
    return;
  }
  hint.textContent = projectId
    ? `Backlog này sẽ có STT ${nextStt(projectId)} trong dự án "${projectName(projectId)}".`
    : 'STT được tự động đánh số theo từng dự án.';
};

/* ---------- Ghi nhớ lựa chọn lần trước (dự án / loại / team) để nhập nhanh ---------- */
/** Khóa localStorage lưu lựa chọn lần trước. */
const DEFAULTS_KEY = 'backlogDefaults';
/** Đọc lựa chọn lần trước (dự án / loại / team); lỗi hoặc chưa có -> rỗng. */
const loadDefaults = (): { project?: string; type?: string; team?: string } => {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? 'null') || {};
  } catch {
    return {};
  }
};
/** Lưu lựa chọn lần này để điền sẵn cho lần nhập sau. */
const saveDefaults = (d: { project: string; type: string; team: string }): void => {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
  } catch {
    // không lưu được (storage bị chặn) -> bỏ qua, chỉ mất tính năng nhớ lựa chọn
  }
};

/** Bộ đếm giờ tự tắt của toast (để hủy khi có toast mới). */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Hiện thông báo nhỏ tự tắt sau 2,2 giây. */
const showToast = (message: string): void => {
  const el = $('#toast');
  $('#toastMsg').textContent = message;
  el.classList.remove('hidden');
  el.classList.add('flex');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('flex');
  }, 2200);
};

/* ---------- Chip chọn nhanh: Loại / Team / Trạng thái ---------- */
/** Class của chip đang chọn / chưa chọn. */
const CHIP_ON = 'border-indigo-600 bg-indigo-600 text-white';
const CHIP_OFF = 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100';
/** Nút chip chọn nhanh. `attrs` là các thuộc tính data-* dùng để nhận diện khi bấm. */
const chip = (attrs: string, label: string, on: boolean, extra = ''): string =>
  `<button type="button" ${attrs} aria-pressed="${on}"
    class="${extra} whitespace-nowrap rounded-full border px-4 py-2.5 text-sm font-medium sm:py-1.5 ${on ? CHIP_ON : CHIP_OFF}">${esc(label)}</button>`;

/** Dòng tóm tắt phần phân loại (dự án · loại · team · trạng thái). */
const updateMetaSummary = (): void => {
  const projectId = $<Field>('#fProject').value;
  const team = teamById($<Field>('#fTeam').value);
  const status = $<Field>('#fStatus').value || 'todo';
  const type = $<Field>('#fType').value.trim();
  const summary = $('#metaSummary');
  summary.textContent = projectId
    ? [
        projectLabel(projectId),
        type || 'Chưa chọn loại',
        team ? team.name : 'Chưa phân công',
        STATUSES[status as FeedbackStatus].label,
      ].join(' · ')
    : '⚠ Chưa chọn dự án';
  summary.classList.toggle('text-red-600', !projectId);
  summary.classList.toggle('text-slate-700', Boolean(projectId));
};

/** Vẽ lại các chip chọn nhanh: loại, team, trạng thái. */
const renderChips = (): void => {
  const type = $<Field>('#fType').value.trim().toLowerCase();
  $('#typeChips').innerHTML = typeList()
    .map((t) => chip(`data-chip-type="${esc(t)}"`, t, t.toLowerCase() === type, 'shrink-0'))
    .join('');

  const team = $<Field>('#fTeam').value;
  $('#teamChips').innerHTML =
    chip('data-chip-team=""', 'Chưa phân công', !team, 'shrink-0') +
    sortedTeams()
      .map((t) => chip(`data-chip-team="${esc(t.id)}"`, t.name, t.id === team, 'shrink-0'))
      .join('');

  const status = $<Field>('#fStatus').value || 'todo';
  $('#statusChips').innerHTML = STATUS_KEYS.map((k) =>
    chip(`data-chip-status="${k}"`, STATUSES[k].label, k === status, '!rounded-lg')
  ).join('');
  updateMetaSummary();
};

/** Mở form backlog: sửa `item` hoặc thêm mới (null); điền sẵn lựa chọn lần trước khi thêm mới. */
const openForm = (item: Feedback | null = null): void => {
  state.editing = item;
  form.reset();
  setError($('#formError'), '');

  $('#modalTitle').textContent = item ? `Sửa backlog #${item.stt}` : 'Thêm backlog';
  $<HTMLButtonElement>('#btnSave').textContent = 'Lưu';
  $<HTMLButtonElement>('#btnSaveNew').classList.toggle('hidden', Boolean(item)); // "Lưu & thêm tiếp" chỉ khi thêm mới

  const d = loadDefaults();
  const projectId = item
    ? item.projectId
    : state.project ||
      (d.project && projectById(d.project) ? d.project : '') ||
      (state.projects.length === 1 ? (state.projects[0]?.id ?? '') : '');
  fillProjectSelect(projectId);
  $<Field>('#fStatus').innerHTML = statusOptions(item ? item.status : 'todo');
  fillTeamSelect(item ? item.teamId : state.team && state.team !== 'none' ? state.team : d.team && teamById(d.team) ? d.team : '');
  $<Field>('#fType').value = item ? item.type : d.type || '';
  $('#typeList').innerHTML = typeList()
    .map((t) => `<option value="${esc(t)}"></option>`)
    .join('');
  $<Field>('#fTitle').value = item ? item.title : '';
  $<Field>('#fNote').value = item ? item.note : '';
  $<HTMLDetailsElement>('#fNoteBox').open = Boolean(item && item.note);
  $<Field>('#fLocationUrl').value = item ? item.location.url : '';
  $<Field>('#fBugText').value = item ? item.bug.text : '';
  $<Field>('#fExpectedText').value = item ? item.expected.text : '';

  resetZone('location', item && item.location.image ? [item.location.image] : []);

  const har = item && item.har;
  $('#fHarBox').classList.toggle('hidden', !har);
  $('#fHarBox').classList.toggle('flex', Boolean(har));
  $<HTMLInputElement>('#fRemoveHar').checked = false;
  if (har) {
    $<HTMLAnchorElement>('#fHarLink').href = har.url;
    $<HTMLAnchorElement>('#fHarLink').download = har.name;
    $<HTMLAnchorElement>('#fHarLink').textContent = `${har.name} (${fmtSize(har.size || 0)})`;
  }
  resetZone('bug', item ? item.bug.images : []);
  resetZone('expected', item ? item.expected.images : []);

  renderChips();
  updateSttHint();
  setActiveZone('bug');
  $<HTMLDetailsElement>('#fMeta').open = !$<Field>('#fProject').value; // chưa có dự án -> mở sẵn phần phân loại
  setOpen(modal, true);
  ($<Field>('#fProject').value ? $<Field>('#fTitle') : $<Field>('#fProject')).focus();
};

/** Đóng form backlog. */
const closeForm = (): void => {
  setOpen(modal, false);
  state.editing = null;
};

/** Gửi form backlog (multipart): kiểm tra, báo sớm nếu quá dung lượng, rồi POST/PUT. */
const submitForm = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const errorBox = $('#formError');
  setError(errorBox, '');

  const projectId = $<Field>('#fProject').value;
  if (!projectId) {
    $<HTMLDetailsElement>('#fMeta').open = true;
    setError(errorBox, 'Vui lòng chọn dự án.');
    $<Field>('#fProject').focus();
    return;
  }
  if (!$<Field>('#fTitle').value.trim() && !$<Field>('#fBugText').value.trim()) {
    setError(errorBox, 'Nhập tên lỗi hoặc mô tả lỗi.');
    $<Field>('#fTitle').focus();
    return;
  }

  const keepOpen = !state.editing && Boolean(event.submitter && event.submitter.id === 'btnSaveNew');
  const fd = new FormData();
  fd.set('project_id', projectId);
  fd.set('status', $<Field>('#fStatus').value);
  fd.set('team_id', $<Field>('#fTeam').value);
  fd.set('type', $<Field>('#fType').value);
  fd.set('title', $<Field>('#fTitle').value);
  fd.set('note_text', $<Field>('#fNote').value);
  fd.set('location_url', $<Field>('#fLocationUrl').value);
  fd.set('bug_text', $<Field>('#fBugText').value);
  fd.set('expected_text', $<Field>('#fExpectedText').value);

  zones.location.files.forEach((f) => fd.append('location_image', f));
  zones.bug.files.forEach((f) => fd.append('bug_images', f));
  zones.expected.files.forEach((f) => fd.append('expected_images', f));

  // Trên Vercel mỗi request chỉ nhận ~4MB: báo sớm thay vì để server từ chối sau khi đã tải lên
  const info: Partial<McpInfo> = mcp.info || (mcp.info = await api<McpInfo>('/api/mcp-info').catch(() => null)) || {};
  const totalBytes = (['location', 'bug', 'expected'] as ZoneName[]).reduce(
    (n, z) => n + zones[z].files.reduce((m, f) => m + f.size, 0),
    0
  );
  if (info.maxUploadBytes && totalBytes > info.maxUploadBytes) {
    setError(
      errorBox,
      `Tổng dung lượng ảnh ${(totalBytes / 1048576).toFixed(1)}MB vượt giới hạn ${(info.maxUploadBytes / 1048576).toFixed(1)}MB mỗi lần lưu. Hãy bớt ảnh rồi lưu, sau đó thêm ảnh còn lại bằng nút Sửa.`
    );
    return;
  }

  if (state.editing) {
    if (zones.location.removed.length) fd.set('remove_location_image', '1');
    fd.set('remove_bug_images', JSON.stringify(zones.bug.removed));
    fd.set('remove_expected_images', JSON.stringify(zones.expected.removed));
    if ($<HTMLInputElement>('#fRemoveHar').checked) fd.set('remove_har', '1');
  }

  const btn = event.submitter || $<HTMLButtonElement>('#btnSave');
  const label = btn.textContent;
  const buttons = [$<HTMLButtonElement>('#btnSave'), $<HTMLButtonElement>('#btnSaveNew')];
  buttons.forEach((b) => (b.disabled = true));
  btn.textContent = 'Đang lưu...';

  try {
    const editing = state.editing;
    const saved = await api(editing ? `/api/feedbacks/${editing.id}` : '/api/feedbacks', {
      method: editing ? 'PUT' : 'POST',
      body: fd,
    });
    saveDefaults({ project: projectId, type: $<Field>('#fType').value.trim(), team: $<Field>('#fTeam').value });
    if (state.project && state.project !== projectId) state.project = projectId;
    if (keepOpen) {
      await load();
      resetForNext();
      showToast(`Đã lưu #${saved.stt} · nhập tiếp`);
    } else {
      closeForm();
      await load();
      showToast(editing ? 'Đã cập nhật' : `Đã lưu #${saved.stt}`);
    }
  } catch (err) {
    setError(errorBox, errorMessage(err));
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    btn.textContent = label;
  }
};

/** Sau "Lưu & thêm tiếp": xóa nội dung lỗi, giữ nguyên dự án / loại / team / trạng thái. */
const resetForNext = (): void => {
  ['#fTitle', '#fLocationUrl', '#fBugText', '#fExpectedText', '#fNote'].forEach((sel) => ($<Field>(sel).value = ''));
  $<HTMLDetailsElement>('#fNoteBox').open = false;
  (['location', 'bug', 'expected'] as ZoneName[]).forEach((z) => resetZone(z));
  setError($('#formError'), '');
  $('#typeList').innerHTML = typeList()
    .map((t) => `<option value="${esc(t)}"></option>`)
    .join('');
  renderChips();
  updateSttHint();
  $<Field>('#fTitle').focus();
  $<Field>('#fTitle').scrollIntoView({ block: 'center' });
};

/** Xóa backlog sau khi xác nhận. */
const removeFeedback = async (id: string): Promise<void> => {
  const item = state.items.find((f) => f.id === id);
  if (!item) return;
  if (!confirm(`Xóa backlog #${item.stt} của dự án "${projectName(item.projectId)}"?`)) return;
  try {
    await api(`/api/feedbacks/${id}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    alert(errorMessage(err));
  }
};

/* ---------- Form dự án ---------- */
/** Mở form dự án; `fromForm` = mở từ form backlog để quay lại chọn dự án vừa tạo. */
const openProjectForm = (project: Project | null = null, fromForm = false): void => {
  state.editingProject = project;
  state.projectFromForm = fromForm;
  projectForm.reset();
  setError($('#projectFormError'), '');
  $('#projectModalTitle').textContent = project ? 'Sửa dự án' : 'Thêm dự án';
  $<HTMLButtonElement>('#btnSaveProject').textContent = project ? 'Lưu thay đổi' : 'Lưu dự án';
  $<Field>('#pCode').value = project ? project.code || '' : '';
  $<Field>('#pName').value = project ? project.name : '';
  $<Field>('#pDescription').value = project ? project.description || '' : '';
  setOpen(projectModal, true);
  $<Field>('#pName').focus();
};

/** Đóng form dự án. */
const closeProjectForm = (): void => {
  setOpen(projectModal, false);
  state.editingProject = null;
  state.projectFromForm = false;
};

/** Lưu dự án. */
const submitProjectForm = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const errorBox = $('#projectFormError');
  setError(errorBox, '');

  const name = $<Field>('#pName').value.trim();
  if (!name) {
    setError(errorBox, 'Vui lòng nhập tên dự án.');
    $<Field>('#pName').focus();
    return;
  }

  const btn = $<HTMLButtonElement>('#btnSaveProject');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang lưu...';

  try {
    const editing = state.editingProject;
    const body = { code: $<Field>('#pCode').value, name, description: $<Field>('#pDescription').value };
    const saved = await api(editing ? `/api/projects/${editing.id}` : '/api/projects', jsonBody(editing ? 'PUT' : 'POST', body));
    const fromForm = state.projectFromForm;
    closeProjectForm();
    await load();
    if (fromForm) {
      // Quay lại form backlog và chọn luôn dự án vừa tạo
      fillProjectSelect(saved.id);
      updateSttHint();
      updateMetaSummary();
      $<HTMLDetailsElement>('#fMeta').open = true; // giữ mở để chọn tiếp loại / team
      $<Field>('#fTitle').focus();
    }
  } catch (err) {
    setError(errorBox, errorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

/** Xóa dự án (kèm toàn bộ backlog) sau khi xác nhận. */
const removeProject = async (id: string): Promise<void> => {
  const project = projectById(id);
  if (!project) return;
  const count = state.items.filter((f) => f.projectId === id).length;
  const message = count
    ? `Xóa dự án "${project.name}"?\n\nToàn bộ ${count} backlog (kèm ảnh) của dự án này cũng sẽ bị xóa và không thể khôi phục.`
    : `Xóa dự án "${project.name}"?`;
  if (!confirm(message)) return;
  try {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    alert(errorMessage(err));
  }
};

/* ---------- Form team ---------- */
/** Mở form thêm/sửa team. */
const openTeamForm = (team: Team | null = null): void => {
  state.editingTeam = team;
  teamForm.reset();
  setError($('#teamFormError'), '');
  $('#teamModalTitle').textContent = team ? 'Sửa team' : 'Thêm team';
  $<HTMLButtonElement>('#btnSaveTeam').textContent = team ? 'Lưu thay đổi' : 'Lưu team';
  $<Field>('#tName').value = team ? team.name : '';
  $<Field>('#tLead').value = team ? team.lead || '' : '';
  $<Field>('#tDescription').value = team ? team.description || '' : '';
  setOpen(teamModal, true);
  $<Field>('#tName').focus();
};

/** Đóng form team. */
const closeTeamForm = (): void => {
  setOpen(teamModal, false);
  state.editingTeam = null;
};

/** Lưu team. */
const submitTeamForm = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const errorBox = $('#teamFormError');
  setError(errorBox, '');

  const name = $<Field>('#tName').value.trim();
  if (!name) {
    setError(errorBox, 'Vui lòng nhập tên team.');
    $<Field>('#tName').focus();
    return;
  }

  const btn = $<HTMLButtonElement>('#btnSaveTeam');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang lưu...';

  try {
    const editing = state.editingTeam;
    const body = { name, lead: $<Field>('#tLead').value, description: $<Field>('#tDescription').value };
    await api(editing ? `/api/teams/${editing.id}` : '/api/teams', jsonBody(editing ? 'PUT' : 'POST', body));
    closeTeamForm();
    await load();
  } catch (err) {
    setError(errorBox, errorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

/** Xóa team sau khi xác nhận (backlog của team chuyển về chưa phân công). */
const removeTeam = async (id: string): Promise<void> => {
  const team = teamById(id);
  if (!team) return;
  const count = state.items.filter((f) => f.teamId === id).length;
  const message = count
    ? `Xóa team "${team.name}"?\n\n${count} backlog đang giao cho team này sẽ chuyển về "Chưa phân công" (backlog không bị xóa).`
    : `Xóa team "${team.name}"?`;
  if (!confirm(message)) return;
  try {
    await api(`/api/teams/${id}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    alert(errorMessage(err));
  }
};

/* ---------- Lightbox ---------- */
/** Lớp phủ xem ảnh phóng to. */
const lightbox = $('#lightbox');
/** Mở ảnh phóng to. */
const openLightbox = (src: string): void => {
  $<HTMLImageElement>('#lightboxImg').src = src;
  lightbox.classList.remove('hidden');
  lightbox.classList.add('flex');
};
/** Đóng ảnh phóng to. */
const closeLightbox = (): void => {
  lightbox.classList.add('hidden');
  lightbox.classList.remove('flex');
  $<HTMLImageElement>('#lightboxImg').removeAttribute('src');
};

/* ---------- Events ---------- */
window.addEventListener('hashchange', applyRoute);

// Backlog
$('#btnAdd').addEventListener('click', () => openForm());
// Tải Excel theo bộ lọc hiện tại (dự án, trạng thái, từ khóa)
$('#btnExport').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (state.project) params.set('project', state.project);
  if (state.status) params.set('status', state.status);
  if (state.team) params.set('team', state.team);
  if (state.type) params.set('type', state.type);
  if (state.query.trim()) params.set('q', state.query.trim());
  window.location.href = '/api/export?' + params;
});
$('#btnFilters').addEventListener('click', () => {
  state.filtersOpen = !state.filtersOpen;
  renderFilterBar();
});
/** Bỏ một bộ lọc (hoặc tất cả khi key = 'all'). */
const clearFilter = (key: string): void => {
  if (key === 'all') {
    Object.assign(state, { project: '', type: '', team: '', status: '', query: '' });
    $<Field>('#filterQuery').value = '';
  } else {
    (state as unknown as Record<string, unknown>)[key] = '';
  }
  renderBacklog();
};
$('#btnClearFilters').addEventListener('click', () => clearFilter('all'));
$('#activeChips').addEventListener('click', (e) => {
  const btn = closest(e, '[data-clear]');
  if (btn) clearFilter(data(btn, 'clear'));
});
$<Field>('#filterProject').addEventListener('change', (e) => {
  state.project = fieldValue(e);
  renderBacklog();
});
$<Field>('#filterType').addEventListener('change', (e) => {
  state.type = fieldValue(e);
  renderBacklog();
});
$<Field>('#filterTeam').addEventListener('change', (e) => {
  state.team = fieldValue(e);
  renderBacklog();
});
$<Field>('#filterQuery').addEventListener('input', (e) => {
  state.query = fieldValue(e);
  renderBacklog();
});
$('#statusTabs').addEventListener('click', (e) => {
  const btn = closest(e, '[data-status-filter]');
  if (!btn) return;
  state.status = data(btn, 'statusFilter') as FeedbackStatus | '';
  renderBacklog();
});

$('#rows').addEventListener('click', (e) => {
  const btn = closest(e, '[data-act]');
  if (!btn) return;
  if (data(btn, 'act') === 'edit') openForm(state.items.find((f) => f.id === data(btn, 'id')));
  if (data(btn, 'act') === 'delete') removeFeedback(data(btn, 'id'));
});
$('#rows').addEventListener('change', (e) => {
  const select = closest<Field>(e, '[data-status-id]');
  if (select) changeStatus(data(select, 'statusId'), select.value);
  const team = closest<Field>(e, '[data-team-id]');
  if (team) changeTeam(data(team, 'teamId'), team.value);
});

// Sắp xếp, chế độ xem, phân trang
$<Field>('#sortBy').addEventListener('change', (e) => {
  state.sort = fieldValue(e) as SortKey;
  renderBacklog();
});
$$('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    state.mode = data(b, 'mode') as ViewMode;
    try {
      localStorage.setItem('backlogMode', state.mode);
    } catch {
      // không lưu được chế độ xem -> vẫn dùng bình thường trong phiên này
    }
    renderBacklog();
  })
);
$('#pager').addEventListener('click', (e) => {
  const btn = closest<HTMLButtonElement>(e, '[data-page]');
  if (!btn || btn.disabled) return;
  state.page = Number(data(btn, 'page'));
  renderBacklog();
  $('#viewBacklog').scrollIntoView({ block: 'start' });
});

/** Id backlog đang được kéo trên Kanban. */
let dragId: string | null = null;
/** Vùng Kanban, dùng chung cho các sự kiện kéo thả bên dưới. */
const board = $('#boardWrap');
board.addEventListener('click', (e) => {
  const btn = closest(e, '[data-act="edit"]');
  if (btn) openForm(state.items.find((f) => f.id === data(btn, 'id')));
});
board.addEventListener('dragstart', (e) => {
  const card = closest(e, '[data-card]');
  if (!card) return;
  dragId = data(card, 'card');
  e.dataTransfer?.setData('text/plain', dragId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  card.classList.add('opacity-50');
});
board.addEventListener('dragend', () => {
  dragId = null;
  $$('[data-card]', board).forEach((c) => c.classList.remove('opacity-50'));
  $$('[data-col]', board).forEach((c) => c.classList.remove('ring-2', 'ring-indigo-300'));
});
board.addEventListener('dragover', (e) => {
  const col = closest(e, '[data-col]');
  if (!col || !dragId) return;
  e.preventDefault();
  $$('[data-col]', board).forEach((c) => c.classList.toggle('ring-2', c === col));
  $$('[data-col]', board).forEach((c) => c.classList.toggle('ring-indigo-300', c === col));
});
board.addEventListener('drop', (e) => {
  const col = closest(e, '[data-col]');
  if (!col || !dragId) return;
  e.preventDefault();
  changeStatus(dragId, data(col, 'col'));
});

// Dự án
$('#btnAddProject').addEventListener('click', () => openProjectForm());
$<Field>('#projectQuery').addEventListener('input', (e) => {
  state.projectQuery = fieldValue(e);
  renderProjects();
});
$('#projectRows').addEventListener('click', (e) => {
  const btn = closest(e, '[data-pact]');
  if (!btn) return;
  const id = data(btn, 'id');
  if (data(btn, 'pact') === 'open') {
    location.hash = '#/backlog?project=' + encodeURIComponent(id);
  }
  if (data(btn, 'pact') === 'edit') openProjectForm(projectById(id));
  if (data(btn, 'pact') === 'delete') removeProject(id);
});

// Team
$('#btnAddTeam').addEventListener('click', () => openTeamForm());
$<Field>('#teamQuery').addEventListener('input', (e) => {
  state.teamQuery = fieldValue(e);
  renderTeams();
});
$('#teamRows').addEventListener('click', (e) => {
  const btn = closest(e, '[data-tact]');
  if (!btn) return;
  const id = data(btn, 'id');
  if (data(btn, 'tact') === 'open') location.hash = '#/backlog?team=' + encodeURIComponent(id);
  if (data(btn, 'tact') === 'edit') openTeamForm(teamById(id));
  if (data(btn, 'tact') === 'delete') removeTeam(id);
});
teamForm.addEventListener('submit', submitTeamForm);
$$('[data-close-team]').forEach((el) => el.addEventListener('click', closeTeamForm));

// Người dùng
/** Cách đăng nhập quản trị đang chọn. */
let loginMode: 'password' | 'token' = 'password';
/** Chuyển giữa đăng nhập bằng mật khẩu và bằng token cá nhân. */
const setLoginMode = (mode: 'password' | 'token'): void => {
  loginMode = mode;
  $('#loginPasswordFields').classList.toggle('hidden', mode !== 'password');
  $('#loginTokenFields').classList.toggle('hidden', mode !== 'token');
  $('#btnLoginMode').textContent = mode === 'password' ? 'Đăng nhập bằng token cá nhân' : 'Đăng nhập bằng email và mật khẩu';
  setError($('#adminKeyError'), '');
  (mode === 'password' ? $<Field>('#adminEmail') : $<Field>('#adminKey')).focus();
};
$('#btnLoginMode').addEventListener('click', () => setLoginMode(loginMode === 'password' ? 'token' : 'password'));

$<HTMLFormElement>('#adminKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorBox = $('#adminKeyError');
  setError(errorBox, '');
  const btn = $<HTMLButtonElement>('#btnAdminKey');

  if (loginMode === 'token') {
    const key = $<Field>('#adminKey').value.trim();
    if (!key) return setError(errorBox, 'Vui lòng dán token quản trị.');
    adminKey.set(key);
    $<Field>('#adminKey').value = '';
  } else {
    const email = $<Field>('#adminEmail').value.trim();
    const password = $<Field>('#adminPassword').value;
    if (!email || !password) return setError(errorBox, 'Vui lòng nhập email và mật khẩu.');
    btn.disabled = true;
    try {
      const res = await api('/api/admin/login', jsonBody('POST', { email, password }));
      adminKey.set(res.token);
      $<Field>('#adminPassword').value = '';
    } catch (err) {
      setError(errorBox, errorMessage(err));
      btn.disabled = false;
      return;
    }
  }
  btn.disabled = true;
  await renderUsers();
  btn.disabled = false;
});
$('#btnLockAdmin').addEventListener('click', () => {
  // Hủy phiên trên server (nếu đăng nhập bằng mật khẩu) rồi quay về màn đăng nhập
  if (adminKey.get().startsWith('fbs_')) {
    fetch('/api/admin/session', { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminKey.get() } }).catch(() => {});
  }
  adminKey.set('');
  state.users = [];
  renderUsers();
});
$('#btnRetryUsers').addEventListener('click', () => renderUsers());
$('#btnAddUser').addEventListener('click', () => openUserForm());
$<Field>('#userQuery').addEventListener('input', (e) => {
  state.userQuery = fieldValue(e);
  renderUserTable();
});
$('#userRows').addEventListener('click', (e) => {
  const btn = closest(e, '[data-uact]');
  if (btn) userAction(data(btn, 'uact'), data(btn, 'id'));
});
$<HTMLFormElement>('#userForm').addEventListener('submit', submitUserForm);
$$('[data-close-user]').forEach((el) => el.addEventListener('click', closeUserForm));
$('#btnTokenDone').addEventListener('click', closeToken);
tokenModal.addEventListener('click', async (e) => {
  const btn = closest(e, '[data-copy-token]');
  if (!btn) return;
  await copyText($(data(btn, 'copyToken')).textContent);
  const label = btn.textContent;
  btn.textContent = 'Đã chép ✓';
  setTimeout(() => (btn.textContent = label), 1500);
});

// Sidebar (mobile)
$('#btnMenu').addEventListener('click', () => {
  $('#sidebar').classList.remove('-translate-x-full');
  $('#sidebarBackdrop').classList.remove('hidden');
});
$('#sidebarBackdrop').addEventListener('click', closeSidebar);

projectForm.addEventListener('submit', submitProjectForm);
$$('[data-close-project]').forEach((el) => el.addEventListener('click', closeProjectForm));

// Form backlog
form.addEventListener('submit', submitForm);
$<Field>('#fProject').addEventListener('change', () => {
  updateSttHint();
  updateMetaSummary();
});
$<Field>('#fType').addEventListener('input', renderChips);
// Chọn nhanh bằng một chạm
$<HTMLDetailsElement>('#fMeta').addEventListener('click', (e) => {
  const t = closest(e, '[data-chip-type]');
  const team = closest(e, '[data-chip-team]');
  const status = closest(e, '[data-chip-status]');
  if (t) {
    const same = $<Field>('#fType').value.trim().toLowerCase() === data(t, 'chipType').toLowerCase();
    $<Field>('#fType').value = same ? '' : data(t, 'chipType'); // bấm lại để bỏ chọn
  } else if (team) $<Field>('#fTeam').value = data(team, 'chipTeam');
  else if (status) $<Field>('#fStatus').value = data(status, 'chipStatus');
  else return;
  renderChips();
});
$('#btnQuickProject').addEventListener('click', () => openProjectForm(null, true));
$$('[data-close]').forEach((el) => el.addEventListener('click', closeForm));

// Chọn ảnh / kéo thả / vùng nhận ảnh khi dán
$$('[data-zone]').forEach((section) => {
  const name = data(section, 'zone') as ZoneName;
  ['mouseenter', 'focusin', 'click'].forEach((type) => section.addEventListener(type, () => setActiveZone(name)));
});

$$('[data-pick]').forEach((btn) => btn.addEventListener('click', () => $<HTMLInputElement>(`[data-input="${data(btn, 'pick')}"]`).click()));

$$<HTMLInputElement>('[data-input]').forEach((input) =>
  input.addEventListener('change', () => {
    addFiles(data(input, 'input') as ZoneName, input.files ?? []);
    input.value = '';
  })
);

$$('[data-dropzone]').forEach((box) => {
  const name = data(box, 'dropzone') as ZoneName;
  const setDrop = (on: boolean): void => DROP_ACTIVE.forEach((c) => box.classList.toggle(c, on));
  ['dragenter', 'dragover'].forEach((type) =>
    box.addEventListener(type, (e) => {
      e.preventDefault();
      setDrop(true);
    })
  );
  box.addEventListener('dragleave', () => setDrop(false));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    setDrop(false);
    addFiles(name, e.dataTransfer?.files ?? []);
  });
});

// Xóa ảnh trong form
modal.addEventListener('click', (e) => {
  const btn = closest(e, '[data-remove]');
  if (!btn) return;
  const name = data(btn.closest<HTMLElement>('[data-preview]') as HTMLElement, 'preview') as ZoneName;
  const z = zones[name];
  const index = Number(data(btn, 'index'));

  if (data(btn, 'remove') === 'existing') {
    z.removed.push(...z.existing.splice(index, 1));
  } else {
    z.files.splice(index, 1).forEach(releaseBlob);
  }
  renderZone(name);
});

// Dán ảnh từ clipboard (Ctrl+V)
document.addEventListener('paste', (e) => {
  if (!isOpen(modal) || isOpen(projectModal) || isOpen(teamModal) || isOpen(userModal) || isOpen(tokenModal) || !e.clipboardData) return;
  const files = [...e.clipboardData.items]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  if (!files.length) return; // dán text bình thường
  e.preventDefault();
  addFiles(state.activeZone, files);
});

// Lightbox
document.addEventListener('click', (e) => {
  const img = closest(e, '[data-zoom]');
  if (img) openLightbox(data(img, 'zoom'));
});
lightbox.addEventListener('click', closeLightbox);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isOpen(lightbox)) closeLightbox();
  else if (isOpen(tokenModal))
    return; // token chỉ hiện một lần: bắt buộc bấm "Tôi đã lưu token"
  else if (isOpen(userModal)) closeUserForm();
  else if (isOpen(teamModal)) closeTeamForm();
  else if (isOpen(projectModal)) closeProjectForm();
  else if (isOpen(modal)) closeForm();
});

try {
  const savedMode = localStorage.getItem('backlogMode');
  if (savedMode === 'list' || savedMode === 'board') state.mode = savedMode;
} catch {
  // storage bị chặn -> dùng chế độ mặc định
}

// Khởi động: áp route hiện tại rồi tải dữ liệu
applyRoute();
load();
