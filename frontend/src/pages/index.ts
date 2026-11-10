/**
 * Các trang giao diện render phía server (Handlebars: views/*.hbs).
 *
 * Mỗi trang là một route GET: lấy dữ liệu từ BACKEND qua HTTP (`/api/...`), tính "view-model"
 * (dữ liệu đã sẵn sàng để hiển thị: bộ lọc, phân trang, tiến độ...), rồi `res.render()`.
 * Thao tác thêm / sửa / xóa do JS phía trình duyệt gọi API `/api/...` (được proxy sang backend),
 * xong thì tải lại trang. Frontend không đọc DB và không import code của backend.
 */
import type { Express, Request, Response } from 'express';
import type { AuditEntry, Feedback, FeedbackStatus, McpInfo, Project, PublicUser, Team } from '../types.js';
import { STATUSES, STATUS_KEYS, byName, countByStatus, isHttp, makeProgress, optionItems, qs, qstr } from './util.js';

/** Dữ liệu dùng chung của các trang, lấy từ backend. */
export interface Data {
  projects: Project[];
  teams: Team[];
  feedbacks: Feedback[];
}

/** Dữ liệu trang Người dùng: trạng thái đăng nhập quản trị và (nếu đã đăng nhập) danh sách. */
export interface UsersData {
  /** disabled = chưa có admin nào; locked = chưa đăng nhập; ok = đã đăng nhập. */
  state: 'disabled' | 'locked' | 'ok';
  users: PublicUser[];
  audit: AuditEntry[];
}

/** Những thứ trang cần từ server.ts (truyền vào để tách biệt khỏi cách gọi backend). */
export interface PagesDeps {
  version: string;
  /** Lấy dự án, team, backlog từ backend. */
  loadData: (req: Request) => Promise<Data>;
  /** Lấy người dùng + nhật ký từ backend (kèm cookie đăng nhập của request). */
  loadUsers: (req: Request) => Promise<UsersData>;
  /** Thông tin cấu hình MCP / xác thực từ backend. */
  loadMcpInfo: (req: Request) => Promise<McpInfo>;
}

/** Địa chỉ gốc của web app, dùng dựng URL MCP: PUBLIC_URL hoặc theo request. */
const baseUrl = (req: Request): string => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** Nhãn dự án dạng "MÃ - Tên" (hoặc chỉ tên nếu không có mã). */
const projectLabel = (p: Project | undefined): string => (p ? (p.code ? `${p.code} - ${p.name}` : p.name) : '(không rõ)');

/** Danh sách loại: mặc định + các loại đã dùng (không phân biệt hoa thường), sắp xếp theo tên. */
const typeList = (items: Feedback[]): string[] => {
  const seen = new Map<string, string>();
  for (const t of ['App customer', 'Website admin', ...items.map((f) => f.type)].filter(Boolean)) {
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'vi'));
};

/** Số backlog mỗi trang (chế độ bảng). */
const PAGE_SIZE = 20;

/* ---------- Dashboard ---------- */

/** Một dòng "khối lượng công việc" (theo team hoặc dự án) kèm thanh tiến độ. */
const loadRow = (name: string, items: Feedback[], href: string) => {
  const counts = countByStatus(items);
  return { name, href, total: items.length, todo: counts.todo, doing: counts.doing, progress: makeProgress(counts, items.length) };
};

function dashboardModel(db: Data) {
  const counts = countByStatus(db.feedbacks);
  const total = db.feedbacks.length;
  const unassigned = db.feedbacks.filter((f) => !f.teamId && f.status !== 'done').length;
  const teamRows = byName(db.teams).map((t) =>
    loadRow(
      t.name,
      db.feedbacks.filter((f) => f.teamId === t.id),
      `/backlog${qs({ team: t.id })}`
    )
  );
  const none = db.feedbacks.filter((f) => !f.teamId);
  if (none.length) teamRows.push(loadRow('Chưa phân công', none, `/backlog${qs({ team: 'none' })}`));
  const projectRows = byName(db.projects).map((p) =>
    loadRow(
      projectLabel(p),
      db.feedbacks.filter((f) => f.projectId === p.id),
      `/backlog${qs({ project: p.id })}`
    )
  );
  return {
    cards: [
      { label: 'Tổng backlog', value: total, sub: `${db.projects.length} dự án · ${db.teams.length} team`, accent: 'bg-indigo-500' },
      { label: 'Chưa làm', value: counts.todo, sub: `${unassigned} chưa phân công team (chưa xong)`, accent: 'bg-slate-400' },
      { label: 'Đang làm', value: counts.doing, sub: 'Đang được team xử lý', accent: 'bg-amber-500' },
      {
        label: 'Đã hoàn thành',
        value: counts.done,
        sub: total ? `${Math.round((counts.done / total) * 100)}% tổng backlog` : 'Chưa có backlog',
        accent: 'bg-emerald-500',
      },
    ],
    teamRows,
    projectRows,
  };
}

/* ---------- Backlog ---------- */

/** Các kiểu sắp xếp. */
const SORTERS: Record<string, (a: Feedback, b: Feedback, name: (id: string) => string) => number> = {
  project: (a, b, name) => name(a.projectId).localeCompare(name(b.projectId), 'vi') || a.stt - b.stt,
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
};

function backlogModel(req: Request, db: Data) {
  const project = qstr(req.query.project);
  const type = qstr(req.query.type);
  const team = qstr(req.query.team);
  const q = qstr(req.query.q);
  const status = (STATUS_KEYS as string[]).includes(qstr(req.query.status)) ? (qstr(req.query.status) as FeedbackStatus) : '';
  const sort = qstr(req.query.sort) in SORTERS ? qstr(req.query.sort) : 'project';
  const mode = qstr(req.query.mode) === 'board' ? 'board' : 'list';
  const projectById = (id: string) => db.projects.find((p) => p.id === id);
  const teamById = (id: string) => db.teams.find((t) => t.id === id);
  const types = typeList(db.feedbacks);

  // Bỏ bộ lọc trỏ tới mục không còn tồn tại
  const fProject = project && projectById(project) ? project : '';
  const fTeam = team === 'none' || (team && teamById(team)) ? team : '';
  const fType = type === 'none' || types.some((t) => t.toLowerCase() === type.toLowerCase()) ? type : '';

  // Lọc theo dự án + team + loại + từ khóa (chưa lọc trạng thái, để đếm số lượng mỗi trạng thái)
  const needle = q.toLowerCase();
  const base = db.feedbacks
    .filter((f) => !fProject || f.projectId === fProject)
    .filter((f) => !fTeam || (fTeam === 'none' ? !f.teamId : f.teamId === fTeam))
    .filter((f) => !fType || (fType === 'none' ? !f.type : f.type.toLowerCase() === fType.toLowerCase()))
    .filter(
      (f) =>
        !needle ||
        [
          projectLabel(projectById(f.projectId)),
          f.type,
          teamById(f.teamId)?.name,
          f.title,
          f.location.url,
          f.bug.text,
          f.expected.text,
          f.note,
        ].some((s) =>
          String(s || '')
            .toLowerCase()
            .includes(needle)
        )
    );

  const current = {
    project: fProject,
    type: fType,
    team: fTeam,
    status,
    q,
    sort: sort === 'project' ? '' : sort,
    mode: mode === 'list' ? '' : mode,
  };
  /** Link tới trang backlog với các tham số hiện tại, có ghi đè `over`. */
  const href = (over: Record<string, string | number | undefined> = {}): string => `/backlog${qs({ ...current, ...over })}`;

  // Thẻ thống kê kiêm bộ lọc trạng thái
  const counts = countByStatus(base);
  const card = (key: string, label: string, count: number, dot: string) => ({
    key,
    label,
    count,
    dot,
    bar: dot,
    active: status === key,
    pct: base.length ? Math.round((count / base.length) * 100) : 0,
    href: href({ status: key, page: undefined }),
  });
  const tabs = [
    card('', 'Tất cả', base.length, 'bg-indigo-500'),
    ...STATUS_KEYS.map((k) => card(k, STATUSES[k].label, counts[k], STATUSES[k].dot)),
  ];

  // Danh sách sau khi lọc trạng thái + sắp xếp + phân trang
  const projectName = (id: string): string => projectById(id)?.name ?? '';
  const sorter = SORTERS[sort] as (typeof SORTERS)[string];
  const list = base.filter((f) => !status || f.status === status).sort((a, b) => sorter(a, b, projectName));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(qstr(req.query.page)) || 1), pages);

  let empty = 'Chưa có backlog nào. Chọn "Thêm backlog" để ghi nhận lỗi đầu tiên.';
  if (!db.projects.length) empty = 'Chưa có dự án nào. Hãy tạo dự án ở tab "Dự án" trước khi thêm backlog.';
  else if (db.feedbacks.length) empty = 'Không có backlog nào khớp với bộ lọc.';

  /** Dữ liệu chung cho dòng bảng / thẻ Kanban. */
  const rowContext = (f: Feedback) => {
    const p = projectById(f.projectId);
    const done = f.status === 'done';
    return {
      id: f.id,
      item: f,
      done,
      type: f.type,
      title: f.title,
      note: f.note,
      project: { code: p?.code ?? '', name: p ? p.name : '(không rõ)', stt: f.stt, done },
      team: {
        id: f.id,
        stt: f.stt,
        hasTeam: Boolean(f.teamId),
        options: optionItems(
          byName(db.teams),
          (t) => t.id,
          (t) => t.name,
          f.teamId
        ),
        updatedAt: f.updatedAt,
        updatedBy: f.updatedBy ?? '',
      },
      status: {
        id: f.id,
        stt: f.stt,
        badge: STATUSES[f.status].badge,
        options: optionItems(
          STATUS_KEYS,
          (k) => k,
          (k) => STATUSES[k].label,
          f.status
        ),
        doneAt: done ? f.completedAt : null,
      },
      location: {
        empty: !f.location.url && !f.location.image && !f.har,
        url: f.location.url,
        isHttp: isHttp(f.location.url),
        image: f.location.image,
        har: f.har,
      },
      bug: f.bug,
      expected: f.expected,
      // Riêng thẻ Kanban
      projectLabel: projectLabel(p),
      stt: f.stt,
      bugText: f.bug.text,
      image: f.bug.images[0] || f.location.image,
      teamName: teamById(f.teamId)?.name ?? '',
      updatedAt: f.updatedAt,
    };
  };

  const columns = STATUS_KEYS.map((k) => {
    const col = list.filter((f) => f.status === k);
    return { key: k, dot: STATUSES[k].dot, label: STATUSES[k].label, count: col.length, cards: col.map(rowContext) };
  });

  // Chip bộ lọc đang áp dụng (bấm × để bỏ)
  const chips: Array<{ label: string; value: string; href: string }> = [];
  if (fProject)
    chips.push({ label: 'Dự án', value: projectLabel(projectById(fProject)), href: href({ project: undefined, page: undefined }) });
  if (fType)
    chips.push({ label: 'Loại', value: fType === 'none' ? 'Chưa phân loại' : fType, href: href({ type: undefined, page: undefined }) });
  if (fTeam)
    chips.push({
      label: 'Team',
      value: fTeam === 'none' ? 'Chưa phân công' : (teamById(fTeam)?.name ?? ''),
      href: href({ team: undefined, page: undefined }),
    });
  if (status) chips.push({ label: 'Trạng thái', value: STATUSES[status].label, href: href({ status: undefined, page: undefined }) });
  const advanced = [fProject, fType, fTeam].filter(Boolean).length;

  return {
    filters: { q, status, sort, mode },
    projectOptions: [
      { value: '', label: 'Tất cả dự án', selected: !fProject },
      ...optionItems(
        byName(db.projects),
        (p) => p.id,
        (p) => projectLabel(p),
        fProject
      ),
    ],
    typeOptions: [
      { value: '', label: 'Tất cả loại', selected: !fType },
      { value: 'none', label: 'Chưa phân loại', selected: fType === 'none' },
      ...types.map((t) => ({ value: t, label: t, selected: t.toLowerCase() === fType.toLowerCase() })),
    ],
    teamOptions: [
      { value: '', label: 'Tất cả team', selected: !fTeam },
      { value: 'none', label: 'Chưa phân công', selected: fTeam === 'none' },
      ...optionItems(
        byName(db.teams),
        (t) => t.id,
        (t) => t.name,
        fTeam
      ),
    ],
    sortOptions: [
      { value: 'project', label: 'Dự án & STT', selected: sort === 'project' },
      { value: 'newest', label: 'Mới tạo', selected: sort === 'newest' },
      { value: 'updated', label: 'Cập nhật gần đây', selected: sort === 'updated' },
    ],
    tabs,
    chips,
    advanced,
    anyFilter: chips.length > 0 || Boolean(q),
    clearHref: `/backlog${qs({ sort: current.sort, mode: current.mode })}`,
    modes: [
      { label: 'Bảng', active: mode === 'list', href: href({ mode: undefined, page: undefined }) },
      { label: 'Kanban', active: mode === 'board', href: href({ mode: 'board', page: undefined }) },
    ],
    board: mode === 'board',
    rows: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(rowContext),
    columns,
    empty,
    resultCount: list.length,
    pager: {
      show: list.length > 0,
      board: mode === 'board',
      total: list.length,
      from: (page - 1) * PAGE_SIZE + 1,
      to: Math.min(list.length, page * PAGE_SIZE),
      page,
      pages,
      prevHref: page > 1 ? href({ page: page - 1 }) : '',
      nextHref: page < pages ? href({ page: page + 1 }) : '',
    },
    exportHref: `/api/export${qs({ project: fProject, status, team: fTeam, type: fType, q })}`,
    // Dữ liệu cho form thêm / sửa (modal) — server render sẵn mọi lựa chọn
    form: {
      projects: optionItems(
        byName(db.projects),
        (p) => p.id,
        (p) => projectLabel(p)
      ),
      teams: byName(db.teams),
      types,
      statuses: STATUS_KEYS.map((k) => ({ key: k, label: STATUSES[k].label })),
      /** STT kế tiếp của từng dự án, để gợi ý trên form. */
      nextStt: JSON.stringify(
        Object.fromEntries(
          db.projects.map((p) => [p.id, db.feedbacks.filter((f) => f.projectId === p.id).reduce((m, f) => Math.max(m, f.stt), 0) + 1])
        )
      ),
      defaultType: '',
      currentProject: fProject,
      currentTeam: fTeam && fTeam !== 'none' ? fTeam : '',
    },
  };
}

/* ---------- Dự án / Team ---------- */

function projectsModel(req: Request, db: Data) {
  const q = qstr(req.query.q).toLowerCase();
  const list = byName(db.projects).filter(
    (p) =>
      !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
  );
  return {
    q: qstr(req.query.q),
    summary: `${db.projects.length} dự án`,
    empty: db.projects.length ? 'Không có dự án nào khớp.' : 'Chưa có dự án nào. Chọn "Thêm dự án" để bắt đầu.',
    rows: list.map((p) => {
      const items = db.feedbacks.filter((f) => f.projectId === p.id);
      return { ...p, item: p, backlogHref: `/backlog${qs({ project: p.id })}`, progress: makeProgress(countByStatus(items), items.length) };
    }),
  };
}

function teamsModel(req: Request, db: Data) {
  const q = qstr(req.query.q).toLowerCase();
  const list = byName(db.teams).filter(
    (t: Team) =>
      !q ||
      [t.name, t.lead, t.description].some((s) =>
        String(s || '')
          .toLowerCase()
          .includes(q)
      )
  );
  return {
    q: qstr(req.query.q),
    summary: `${db.teams.length} team`,
    empty: db.teams.length ? 'Không có team nào khớp.' : 'Chưa có team nào. Chọn "Thêm team" để bắt đầu.',
    rows: list.map((t) => {
      const items = db.feedbacks.filter((f) => f.teamId === t.id);
      return {
        ...t,
        item: t,
        backlogHref: `/backlog${qs({ team: t.id })}`,
        progress: makeProgress(countByStatus(items), items.length, 'Chưa được giao backlog'),
      };
    }),
  };
}

/* ---------- Người dùng ---------- */

/** Nhãn tiếng Việt của quyền người dùng. */
const ROLE_LABEL: Record<string, string> = { read: 'Chỉ đọc', write: 'Đọc + ghi', admin: 'Quản trị viên' };

function usersModel(req: Request, db: Data, u: UsersData) {
  if (u.state !== 'ok') return { state: u.state };

  const q = qstr(req.query.q).toLowerCase();
  const list = [...u.users]
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  return {
    state: 'ok',
    q: qstr(req.query.q),
    summary: `${u.users.length} người dùng`,
    empty: u.users.length ? 'Không có người dùng nào khớp.' : 'Chưa có người dùng nào. Chọn "Thêm người dùng" để cấp token đầu tiên.',
    teamOptions: [
      { value: '', label: '— Không —' },
      ...optionItems(
        byName(db.teams),
        (t) => t.id,
        (t) => t.name
      ),
    ],
    rows: list.map((row) => {
      const pu = row;
      const status = !pu.hasToken
        ? ['Chưa có token', 'bg-slate-100 text-slate-600']
        : pu.active
          ? ['Hoạt động', 'bg-emerald-50 text-emerald-700']
          : ['Vô hiệu hóa', 'bg-red-50 text-red-700'];
      return {
        item: pu,
        id: pu.id,
        name: pu.name,
        email: pu.email,
        roleLabel: ROLE_LABEL[pu.role] || pu.role,
        roleClass:
          pu.role === 'admin'
            ? 'bg-amber-50 text-amber-800'
            : pu.role === 'write'
              ? 'bg-indigo-50 text-indigo-700'
              : 'bg-slate-100 text-slate-700',
        teamName: db.teams.find((t) => t.id === pu.teamId)?.name ?? '',
        hasToken: pu.hasToken,
        tokenHint: pu.tokenHint,
        tokenCreatedAt: pu.tokenCreatedAt,
        lastUsedAt: pu.lastUsedAt,
        statusLabel: status[0],
        statusClass: status[1],
      };
    }),
    audit: u.audit,
  };
}

/* ---------- Hướng dẫn MCP ---------- */

function mcpModel(req: Request, info: McpInfo) {
  const { authRequired, readonly } = info;
  const url = baseUrl(req) + '/mcp';
  const header = authRequired ? 'Authorization: Bearer <TOKEN>' : '';
  const bearerHeader = { Authorization: 'Bearer <TOKEN>' };
  const json = (o: unknown): string => JSON.stringify(o, null, 2);
  const tabs = [
    {
      key: 'claude-cli',
      label: 'Claude Code (CLI)',
      hint: 'Chạy một lần trong terminal. Thêm --scope user để dùng ở mọi project, hoặc --scope project để ghi vào .mcp.json và chia sẻ cho cả team.',
      code: `claude mcp add --transport http feedback-backlog ${url}${authRequired ? ` \\\n  --header "${header}"` : ''}`,
    },
    {
      key: 'claude-json',
      label: '.mcp.json (Claude Code)',
      hint: 'Commit file này vào repo dự án để cả team dùng chung. Mỗi dev tự đặt biến môi trường BACKLOG_MCP_TOKEN, không ghi token vào file.',
      code: json({
        mcpServers: {
          'feedback-backlog': { type: 'http', url, ...(authRequired ? { headers: { Authorization: 'Bearer ${BACKLOG_MCP_TOKEN}' } } : {}) },
        },
      }),
    },
    {
      key: 'cursor',
      label: 'Cursor',
      hint: 'Thêm vào ~/.cursor/mcp.json (toàn cục) hoặc .cursor/mcp.json (theo project), rồi bật server trong Settings → MCP.',
      code: json({ mcpServers: { 'feedback-backlog': { url, ...(authRequired ? { headers: bearerHeader } : {}) } } }),
    },
    {
      key: 'vscode',
      label: 'VS Code',
      hint: 'Tạo file .vscode/mcp.json trong project (cần GitHub Copilot Chat, chế độ Agent).',
      code: json({ servers: { 'feedback-backlog': { type: 'http', url, ...(authRequired ? { headers: bearerHeader } : {}) } } }),
    },
    {
      key: 'desktop',
      label: 'Claude Desktop',
      hint: 'Claude Desktop chưa nối trực tiếp tới HTTP bằng file cấu hình nên dùng cầu nối mcp-remote (cần Node.js). Thêm vào claude_desktop_config.json rồi khởi động lại app.',
      code: json({
        mcpServers: {
          'feedback-backlog': { command: 'npx', args: ['-y', 'mcp-remote', url, ...(authRequired ? ['--header', header] : [])] },
        },
      }),
    },
  ].map((t, i) => ({ ...t, active: i === 0 }));
  return {
    url,
    authRequired,
    badges: [
      {
        label: authRequired ? 'Token cá nhân' : 'Không cần token',
        cls: authRequired ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
      },
      { label: readonly ? 'Chỉ đọc' : 'Đọc + ghi', cls: readonly ? 'bg-slate-100 text-slate-700' : 'bg-indigo-50 text-indigo-700' },
    ],
    tabs,
    firstTab: tabs[0],
    curl:
      `curl -s ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n` +
      (authRequired ? '  -H "Authorization: Bearer <TOKEN>" \\\n' : '') +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
}

/* ---------- Đăng ký route ---------- */

/**
 * Gắn các route trang vào app Express.
 * (Trang hướng dẫn MCP ở `/mcp-guide` vì `/mcp` là endpoint JSON-RPC của MCP, được proxy sang backend.)
 */
export function registerPages(app: Express, deps: PagesDeps): void {
  /**
   * Dựng route render một view: lấy dữ liệu từ backend, tính view-model rồi render.
   * Backend không kết nối được -> trả trang lỗi 502 dễ hiểu.
   */
  const page =
    <T>(view: string, tab: string, title: string, fetchData: (req: Request) => Promise<T>, build: (req: Request, data: T) => object) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const data = await fetchData(req);
        res.render(view, { tab, title, version: deps.version, ...build(req, data) });
      } catch (e) {
        console.error('[frontend] không lấy được dữ liệu từ backend:', (e as Error).message);
        res.status(502).send(`Không kết nối được backend (${(e as Error).message}). Kiểm tra BACKEND_URL và backend đang chạy.`);
      }
    };

  app.get('/', (req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', page('dashboard', 'dashboard', 'Dashboard', deps.loadData, (req, db) => dashboardModel(db)));
  app.get('/backlog', page('backlog', 'backlog', 'Backlog', deps.loadData, backlogModel));
  app.get('/projects', page('projects', 'projects', 'Dự án', deps.loadData, projectsModel));
  app.get('/teams', page('teams', 'teams', 'Team xử lý', deps.loadData, teamsModel));
  app.get(
    '/users',
    page(
      'users',
      'users',
      'Người dùng',
      async (req) => ({ data: await deps.loadData(req), users: await deps.loadUsers(req) }),
      (req, d) => usersModel(req, d.data, d.users)
    )
  );
  app.get('/mcp-guide', page('mcp', 'mcp', 'Kết nối MCP', deps.loadMcpInfo, mcpModel));
}
