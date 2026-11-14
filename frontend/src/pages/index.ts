/**
 * Các trang giao diện render phía server (Handlebars: views/*.hbs).
 *
 * Mỗi trang là một route GET: lấy dữ liệu từ BACKEND qua HTTP (`/api/...`), tính "view-model"
 * (dữ liệu đã sẵn sàng để hiển thị: bộ lọc, phân trang, tiến độ...), rồi `res.render()`.
 * Thao tác thêm / sửa / xóa do JS phía trình duyệt gọi API `/api/...` (được proxy sang backend),
 * xong thì tải lại trang. Frontend không đọc DB và không import code của backend.
 */
import type { Express, Request, Response } from 'express';
import type { ActivityEntry, AuditEntry, Feedback, FeedbackStatus, McpInfo, PaymentRound, Project, ProjectDocument, ProjectMember, PublicUser, Team } from '../types.js';
import { DOC_STATUSES, DOC_STATUS_KEYS, STATUSES, STATUS_KEYS, TONES, byName, countByStatus, fmtSize, isHttp, makeProgress, money, optionItems, qs, qstr } from './util.js';

/** Dữ liệu dùng chung của các trang, lấy từ backend. */
export interface Data {
  projects: Project[];
  teams: Team[];
  feedbacks: Feedback[];
  activity: ActivityEntry[];
  paymentRounds: PaymentRound[];
  members: ProjectMember[];
  documents: ProjectDocument[];
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
      db.feedbacks.filter((f) => f.teamId === t.idPublic),
      `/backlog${qs({ team: t.idPublic })}`
    )
  );
  const none = db.feedbacks.filter((f) => !f.teamId);
  if (none.length) teamRows.push(loadRow('Chưa phân công', none, `/backlog${qs({ team: 'none' })}`));
  const projectRows = byName(db.projects).map((p) =>
    loadRow(
      projectLabel(p),
      db.feedbacks.filter((f) => f.projectId === p.idPublic),
      `/backlog${qs({ project: p.idPublic })}`
    )
  );
  return {
    cards: [
      { label: 'Tổng backlog', value: total, sub: `${db.projects.length} dự án · ${db.teams.length} team`, accent: TONES.primary.dot },
      { label: 'Chưa làm', value: counts.todo, sub: `${unassigned} chưa phân công team (chưa xong)`, accent: TONES.neutral.dot },
      { label: 'Đang làm', value: counts.doing, sub: 'Đang được team xử lý', accent: TONES.warning.dot },
      {
        label: 'Đã hoàn thành',
        value: counts.done,
        sub: total ? `${Math.round((counts.done / total) * 100)}% tổng backlog` : 'Chưa có backlog',
        accent: TONES.success.dot,
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

/**
 * Phạm vi hiển thị danh sách backlog nằm trong trang khác (vd tab Backlog của trang dự án):
 * cố định một dự án, và mọi link lọc / phân trang giữ nguyên đường dẫn `basePath` + `fixedParams`.
 */
export interface BacklogScope {
  projectId: string;
  basePath: string;
  fixedParams: Record<string, string>;
}

function backlogModel(req: Request, db: Data, scope?: BacklogScope) {
  const project = scope ? scope.projectId : qstr(req.query.project);
  const type = qstr(req.query.type);
  const team = qstr(req.query.team);
  const q = qstr(req.query.q);
  const status = (STATUS_KEYS as string[]).includes(qstr(req.query.status)) ? (qstr(req.query.status) as FeedbackStatus) : '';
  const sort = qstr(req.query.sort) in SORTERS ? qstr(req.query.sort) : 'project';
  const mode = qstr(req.query.mode) === 'board' ? 'board' : 'list';
  const projectById = (id: string) => db.projects.find((p) => p.idPublic === id);
  const teamById = (id: string) => db.teams.find((t) => t.idPublic === id);
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
    project: scope ? '' : fProject, // trong phạm vi dự án, dự án đã nằm trong basePath
    type: fType,
    team: fTeam,
    status,
    q,
    sort: sort === 'project' ? '' : sort,
    mode: mode === 'list' ? '' : mode,
  };
  /** Link tới trang backlog với các tham số hiện tại, có ghi đè `over`. */
  const basePath = scope?.basePath ?? '/backlog';
  const href = (over: Record<string, string | number | undefined> = {}): string => `${basePath}${qs({ ...scope?.fixedParams, ...current, ...over })}`;

  // Thẻ thống kê kiêm bộ lọc trạng thái
  const counts = countByStatus(base);
  const card = (key: string, label: string, count: number, dot: string, progress: string) => ({
    key,
    label,
    count,
    dot,
    progress,
    active: status === key,
    pct: base.length ? Math.round((count / base.length) * 100) : 0,
    href: href({ status: key, page: undefined }),
  });
  const tabs = [
    card('', 'Tất cả', base.length, TONES.primary.dot, TONES.primary.progress),
    ...STATUS_KEYS.map((k) => card(k, STATUSES[k].label, counts[k], STATUSES[k].dot, STATUSES[k].progress)),
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
      id: f.idPublic,
      item: f,
      done,
      type: f.type,
      title: f.title,
      note: f.note,
      project: { code: p?.code ?? '', name: p ? p.name : '(không rõ)', stt: f.stt, done },
      team: {
        id: f.idPublic,
        stt: f.stt,
        hasTeam: Boolean(f.teamId),
        options: optionItems(
          byName(db.teams),
          (t) => t.idPublic,
          (t) => t.name,
          f.teamId
        ),
        updatedAt: f.updatedAt,
        updatedBy: f.updatedBy ?? '',
        assigneeName: db.members.find((member) => member.idPublic === f.assigneeId)?.name || '',
      },
      status: {
        id: f.idPublic,
        stt: f.stt,
        badge: STATUSES[f.status].badge,
        select: STATUSES[f.status].select,
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
      statusLabel: STATUSES[f.status].label,
      statusBadge: STATUSES[f.status].badge,
      // Tóm tắt trên dòng bảng: nhìn qua là biết lỗi gì, cần làm gì
      expectedText: f.expected.text,
      imageCount: f.bug.images.length + f.expected.images.length + (f.location.image ? 1 : 0),
      hasHar: Boolean(f.har),
      locationUrl: isHttp(f.location.url) ? f.location.url : '',
      // Riêng thẻ Kanban
      projectLabel: projectLabel(p),
      stt: f.stt,
      bugText: f.bug.text,
      image: f.bug.images[0] || f.location.image,
      teamName: teamById(f.teamId)?.name ?? '',
      assigneeName: db.members.find((member) => member.idPublic === f.assigneeId)?.name ?? '',
      updatedAt: f.updatedAt,
    };
  };

  const columns = STATUS_KEYS.map((k) => {
    const col = list.filter((f) => f.status === k);
    return { key: k, dot: STATUSES[k].dot, label: STATUSES[k].label, count: col.length, cards: col.map(rowContext) };
  });

  // Chip bộ lọc đang áp dụng (bấm × để bỏ)
  const chips: Array<{ label: string; value: string; href: string }> = [];
  if (fProject && !scope)
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
  const advanced = [scope ? '' : fProject, fType, fTeam].filter(Boolean).length;

  return {
    filters: { q, status, sort, mode },
    memberOptions: db.members,
    projectOptions: [
      { value: '', label: 'Tất cả dự án', selected: !fProject },
      ...optionItems(
        byName(db.projects),
        (p) => p.idPublic,
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
        (t) => t.idPublic,
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
    clearHref: `${basePath}${qs({ ...scope?.fixedParams, sort: current.sort, mode: current.mode })}`,
    scoped: Boolean(scope),
    formAction: basePath,
    fixedParams: Object.entries(scope?.fixedParams ?? {}).map(([name, value]) => ({ name, value })),
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
      show: mode !== 'board' && pages > 1,
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
        (p) => p.idPublic,
        (p) => projectLabel(p)
      ),
      teams: byName(db.teams),
      members: db.members,
      types,
      statuses: STATUS_KEYS.map((k) => ({ key: k, label: STATUSES[k].label })),
      /** STT kế tiếp của từng dự án, để gợi ý trên form. */
      nextStt: JSON.stringify(
        Object.fromEntries(
          db.projects.map((p) => [p.idPublic, db.feedbacks.filter((f) => f.projectId === p.idPublic).reduce((m, f) => Math.max(m, f.stt), 0) + 1])
        )
      ),
      defaultType: '',
      /** Dự án theo id (kèm vai trò) — "Loại" của backlog được chọn trong vai trò của dự án đang chọn. */
      projectsJson: JSON.stringify(Object.fromEntries(db.projects.map((p) => [p.idPublic, p]))),
      currentProject: fProject,
      currentTeam: fTeam && fTeam !== 'none' ? fTeam : '',
    },
  };
}

/* ---------- Dự án / Team ---------- */

function projectsModel(req: Request, db: Data) {
  const q = qstr(req.query.q).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const list = byName(db.projects).filter(
    (p) =>
      !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
  );
  return {
    q: qstr(req.query.q),
    memberOptions: db.members,
    summary: `${db.projects.length} dự án`,
    empty: db.projects.length ? 'Không có dự án nào khớp.' : 'Chưa có dự án nào. Chọn "Thêm dự án" để bắt đầu.',
    rows: list.map((p) => {
      const items = db.feedbacks.filter((f) => f.projectId === p.idPublic);
      const counts = countByStatus(items);
      const overdue = Boolean(p.deadline && p.deadline < today && items.some((item) => item.status !== 'done'));
      return { ...p, initial: (p.code || p.name).slice(0, 1).toUpperCase(), overdue, deadlineLabel: p.deadline ? new Date(`${p.deadline}T00:00:00`).toLocaleDateString('vi-VN') : 'Chưa đặt deadline', memberCount: p.memberIds.length, item: p, detailHref: `/projects/${encodeURIComponent(p.idPublic)}`, backlogHref: `/backlog${qs({ project: p.idPublic })}`, total: items.length, todo: counts.todo, doing: counts.doing, done: counts.done, progress: makeProgress(counts, items.length) };
    }),
  };
}

function projectWorkspaceModel(req: Request, db: Data) {
  const project = db.projects.find((p) => p.idPublic === req.params.id);
  if (!project) return { missing: true };
  const tasks = db.feedbacks.filter((f) => f.projectId === project.idPublic).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const payments = db.paymentRounds.filter((payment) => payment.projectId === project.idPublic).sort((a, b) => a.stt - b.stt);
  const counts = countByStatus(tasks);
  const paymentTotal = payments.filter((payment) => payment.paid).reduce((sum, payment) => sum + payment.amount, 0);
  const paymentPlannedTotal = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const unpaidPaymentCount = payments.filter((payment) => !payment.paid).length;
  const companyPaidPayments = payments.filter((payment) => payment.paid && payment.companyAccount);
  const openCount = counts.todo + counts.doing;
  const unassignedCount = tasks.filter((task) => task.status !== 'done' && !task.teamId).length;
  const unassignedPeopleCount = tasks.filter((task) => task.status !== 'done' && !task.assigneeId).length;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysToDeadline = project.deadline ? Math.ceil((new Date(`${project.deadline}T00:00:00`).getTime() - today.getTime()) / 86400000) : null;
  const isOverdue = daysToDeadline !== null && daysToDeadline < 0 && openCount > 0;
  const memberIds = new Set([...project.memberIds, ...tasks.map((task) => task.assigneeId).filter(Boolean)]);
  const projectMembers = db.members.filter((member) => memberIds.has(member.idPublic)).map((member) => {
    const assigned = tasks.filter((task) => task.assigneeId === member.idPublic);
    return { ...member, initial: member.name.slice(0, 1).toUpperCase(), teamName: db.teams.find((team) => team.idPublic === member.teamId)?.name || 'Chưa thuộc team', workCount: assigned.filter((task) => task.status !== 'done').length, doneCount: assigned.filter((task) => task.status === 'done').length };
  });
  const section = ['overview', 'payments', 'requirements', 'backlog', 'activity'].includes(qstr(req.query.section)) ? qstr(req.query.section) : 'overview';
  const base = `/projects/${encodeURIComponent(project.idPublic)}`;
  // Thứ tự tab theo tần suất dùng của người quản lý dự án: tổng quan → backlog → thanh toán → tài liệu → lịch sử
  const tabs = [
    { key: 'overview', label: 'Tổng quan', count: null },
    { key: 'backlog', label: 'Backlog', count: openCount || null },
    { key: 'payments', label: 'Thanh toán', count: unpaidPaymentCount || null },
    { key: 'requirements', label: 'Tài liệu PTYC', count: db.documents.filter((d) => d.projectId === project.idPublic).length || null },
    { key: 'activity', label: 'Lịch sử', count: null },
  ].map((tab) => ({ ...tab, href: `${base}?section=${tab.key}`, active: tab.key === section }));

  /**
   * "Cần chú ý": mỗi mục là một việc người quản lý nên xử lý, kèm nút đi thẳng tới chỗ xử lý.
   * `editProject` = mở form sửa dự án ngay tại trang.
   */
  type Attention = { tone: 'error' | 'warning' | 'info'; text: string; action: string; href?: string; editProject?: boolean };
  const attention: Attention[] = [];
  if (isOverdue) attention.push({ tone: 'error', text: `Trễ deadline ${Math.abs(daysToDeadline ?? 0)} ngày, còn ${openCount} việc chưa xong`, action: 'Xem việc còn mở', href: `${base}?section=backlog` });
  else if (daysToDeadline !== null && daysToDeadline >= 0 && daysToDeadline <= 7 && openCount)
    attention.push({ tone: 'warning', text: `Còn ${daysToDeadline} ngày tới deadline, ${openCount} việc chưa xong`, action: 'Xem việc còn mở', href: `${base}?section=backlog` });
  if (unassignedCount) attention.push({ tone: 'warning', text: `${unassignedCount} việc chưa có team xử lý`, action: 'Phân công', href: `${base}?section=backlog&team=none` });
  if (unassignedPeopleCount) attention.push({ tone: 'warning', text: `${unassignedPeopleCount} việc đang mở chưa giao người xử lý`, action: 'Giao việc', href: `${base}?section=backlog` });
  if (unpaidPaymentCount) attention.push({ tone: 'warning', text: `${unpaidPaymentCount} đợt thanh toán chưa xác nhận đã thu`, action: 'Xem thanh toán', href: `${base}?section=payments` });
  if (!project.deadline) attention.push({ tone: 'info', text: 'Chưa đặt deadline cho dự án', action: 'Đặt deadline', editProject: true });
  if (!project.totalValue) attention.push({ tone: 'info', text: 'Chưa nhập tổng giá trị dự án (để tính tỷ lệ thu tiền)', action: 'Nhập giá trị', editProject: true });
  if (!project.roles?.length) attention.push({ tone: 'info', text: 'Chưa khai báo vai trò (dùng làm "Loại" khi tạo backlog)', action: 'Thêm vai trò', editProject: true });
  if (!project.memberIds.length) attention.push({ tone: 'info', text: 'Chưa chọn nhân sự tham gia dự án', action: 'Chọn nhân sự', editProject: true });
  return {
    title: project.name,
    crumbs: [{ label: 'Dự án', href: '/projects' }, { label: project.name }],
    project, section, tabs, taskCount: tasks.length, todoCount: counts.todo, doingCount: counts.doing, doneCount: counts.done,
    memberOptions: db.members,
    projectMembers,
    participantCount: projectMembers.length,
    hasParticipants: projectMembers.length > 0,
    unassignedPeopleCount,
    hasUnassignedPeople: unassignedPeopleCount > 0,
    hasOverdue: isOverdue,
    hasDeadline: Boolean(project.deadline),
    hasStartDate: Boolean(project.startDate),
    startDateLabel: project.startDate ? new Date(`${project.startDate}T00:00:00`).toLocaleDateString('vi-VN') : 'Chưa đặt',
    deadlineLabel: project.deadline ? new Date(`${project.deadline}T00:00:00`).toLocaleDateString('vi-VN') : 'Chưa đặt',
    deadlineState: daysToDeadline === null ? 'Chưa đặt deadline' : daysToDeadline < 0 ? `Quá hạn ${Math.abs(daysToDeadline)} ngày` : daysToDeadline === 0 ? 'Đến hạn hôm nay' : `Còn ${daysToDeadline} ngày`,
    openCount, unassignedCount,
    projectState: isOverdue ? 'Dự án đang trễ deadline' : openCount || unassignedCount || unpaidPaymentCount ? 'Có việc cần theo dõi' : tasks.length && payments.length ? 'Đang ổn định' : 'Thiếu dữ liệu theo dõi',
    hasOpenBacklog: openCount > 0,
    hasUnassignedBacklog: unassignedCount > 0,
    hasOverviewConcern: isOverdue || openCount > 0 || unassignedCount > 0 || unpaidPaymentCount > 0,
    hasOverviewData: tasks.length > 0 && payments.length > 0,
    hasPayments: payments.length > 0,
    payments: payments.map((payment) => ({ ...payment, amountLabel: new Intl.NumberFormat('vi-VN').format(payment.amount), dateLabel: payment.paidAt ? new Date(payment.paidAt).toLocaleDateString('vi-VN') : '—', paidLabel: payment.paid ? 'Đã thanh toán' : 'Chưa thanh toán' })),
    paymentCount: payments.length,
    unpaidPaymentCount,
    unpaidPaymentTotalLabel: new Intl.NumberFormat('vi-VN').format(payments.filter((payment) => !payment.paid).reduce((sum, payment) => sum + payment.amount, 0)),
    paymentTotalLabel: new Intl.NumberFormat('vi-VN').format(paymentTotal),
    paymentPlannedTotalLabel: new Intl.NumberFormat('vi-VN').format(paymentPlannedTotal),
    paymentRemainingLabel: new Intl.NumberFormat('vi-VN').format(Math.max(0, project.totalValue - paymentTotal)),
    collectionPct: project.totalValue ? Math.min(100, Math.round((paymentTotal / project.totalValue) * 100)) : 0,
    hasContractValue: project.totalValue > 0,
    projectValueLabel: new Intl.NumberFormat('vi-VN').format(project.totalValue),
    hasCompanyPaidPayments: companyPaidPayments.length > 0,
    hasProjectInvoiceTask: Boolean(project.invoiceFeedbackId),
    backlogPct: tasks.length ? Math.round((counts.done / tasks.length) * 100) : 0,
    recentPayments: [...payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.stt - a.stt).slice(0, 4).map((payment) => ({
      ...payment,
      amountLabel: new Intl.NumberFormat('vi-VN').format(payment.amount),
      dateLabel: payment.paidAt ? new Date(payment.paidAt).toLocaleDateString('vi-VN') : 'Chưa có ngày',
      paidLabel: payment.paid ? 'Đã thanh toán' : 'Chưa thanh toán',
    })),
    tasks: tasks.slice(0, 8).map((f) => ({ ...f, statusLabel: STATUSES[f.status].label, statusBadge: STATUSES[f.status].badge })),
    activity: db.activity.filter((entry) => entry.projectId === project.idPublic).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((entry) => ({
      ...entry,
      actionLabel: ({ created: 'Tạo mới', updated: 'Cập nhật', status: 'Đổi trạng thái', assigned: 'Đổi người xử lý', deleted: 'Đã xóa' } as Record<string, string>)[entry.action],
      typeLabel: entry.entityType === 'ptyc' ? 'PTYC' : entry.entityType === 'payment' ? 'Thanh toán' : 'Backlog',
      dateLabel: new Date(entry.createdAt).toLocaleString('vi-VN'),
    })),
    attention,
    deadlineTone: isOverdue ? 'text-error' : daysToDeadline !== null && daysToDeadline <= 7 && openCount ? 'text-warning' : '',
    backlogSectionHref: `${base}?section=backlog`,
    paymentsSectionHref: `${base}?section=payments`,
    backlogHref: `/backlog${qs({ project: project.idPublic })}`,
    documents:
      section === 'requirements'
        ? documentsModel(req, db, { projectId: project.idPublic, basePath: `/projects/${encodeURIComponent(project.idPublic)}`, fixedParams: { section: 'requirements' } })
        : null,
    backlog:
      section === 'backlog'
        ? backlogModel(req, db, { projectId: project.idPublic, basePath: `/projects/${encodeURIComponent(project.idPublic)}`, fixedParams: { section: 'backlog' } })
        : null,
    created: new Date(project.createdAt).toLocaleDateString('vi-VN'),
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
      const items = db.feedbacks.filter((f) => f.teamId === t.idPublic);
      return {
        ...t,
        item: t,
        backlogHref: `/backlog${qs({ team: t.idPublic })}`,
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
        (t) => t.idPublic,
        (t) => t.name
      ),
    ],
    rows: list.map((row) => {
      const pu = row;
      const status = !pu.hasToken
        ? ['Chưa có token', TONES.neutral.badge]
        : pu.active
          ? ['Hoạt động', TONES.success.badge]
          : ['Vô hiệu hóa', TONES.error.badge];
      return {
        item: pu,
        id: pu.idPublic,
        name: pu.name,
        email: pu.email,
        roleLabel: ROLE_LABEL[pu.role] || pu.role,
        roleClass:
          pu.role === 'admin' ? TONES.warning.badge : pu.role === 'write' ? TONES.primary.badge : TONES.neutral.badge,
        teamName: db.teams.find((t) => t.idPublic === pu.teamId)?.name ?? '',
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
        cls: authRequired ? TONES.success.badge : TONES.warning.badge,
      },
      { label: readonly ? 'Chỉ đọc' : 'Đọc + ghi', cls: readonly ? TONES.neutral.badge : TONES.primary.badge },
    ],
    tabs,
    firstTab: tabs[0],
    curl:
      `curl -s ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n` +
      (authRequired ? '  -H "Authorization: Bearer <TOKEN>" \\\n' : '') +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
}

/* ---------- Tài liệu PTYC ---------- */

/** Phạm vi danh sách tài liệu nằm trong trang dự án (cố định dự án, giữ đường dẫn của trang). */
interface DocScope {
  projectId: string;
  basePath: string;
  fixedParams: Record<string, string>;
}

/** Loại tài liệu gợi ý (vẫn nhập được loại khác). */
const DOC_TYPES = ['Đặc tả nghiệp vụ', 'Business requirement', 'Đặc tả tích hợp', 'Thiết kế giao diện', 'Biên bản họp', 'Hợp đồng / Phụ lục'];

function documentsModel(req: Request, db: Data, scope?: DocScope) {
  const projectFilter = scope ? scope.projectId : qstr(req.query.project);
  const statusFilter = (DOC_STATUS_KEYS as string[]).includes(qstr(req.query.status)) ? qstr(req.query.status) : '';
  const q = qstr(req.query.q);
  const needle = q.toLowerCase();
  const projectById = (id: string) => db.projects.find((p) => p.idPublic === id);
  const base = db.documents.filter((d) => !projectFilter || d.projectId === projectFilter);
  const list = base
    .filter((d) => !statusFilter || d.status === statusFilter)
    .filter((d) => !needle || [d.title, d.docType, d.note, projectLabel(projectById(d.projectId)), ...d.versions.map((v) => v.file.name)].some((x) => String(x).toLowerCase().includes(needle)));
  const basePath = scope?.basePath ?? '/requirements';
  const href = (over: Record<string, string | undefined>) => `${basePath}${qs({ ...scope?.fixedParams, project: scope ? undefined : projectFilter, status: statusFilter, q, ...over })}`;
  const counts = Object.fromEntries(DOC_STATUS_KEYS.map((k) => [k, base.filter((d) => d.status === k).length])) as Record<string, number>;
  return {
    scoped: Boolean(scope),
    formAction: basePath,
    fixedParams: Object.entries(scope?.fixedParams ?? {}).map(([name, value]) => ({ name, value })),
    q,
    tabs: [
      { key: '', label: 'Tất cả', count: base.length, active: !statusFilter, href: href({ status: undefined }) },
      ...DOC_STATUS_KEYS.map((k) => ({ key: k, label: DOC_STATUSES[k].label, count: counts[k], active: statusFilter === k, href: href({ status: k }) })),
    ],
    filterStatus: statusFilter,
    projectOptions: [{ value: '', label: 'Tất cả dự án', selected: !projectFilter }, ...optionItems(byName(db.projects), (p) => p.idPublic, (p) => projectLabel(p), projectFilter)],
    anyFilter: Boolean(q || statusFilter || (!scope && projectFilter)),
    clearHref: `${basePath}${qs({ ...scope?.fixedParams })}`,
    total: list.length,
    empty: db.documents.length ? 'Không có tài liệu nào khớp bộ lọc.' : 'Chưa có tài liệu PTYC nào. Bấm "Tải tài liệu" để thêm tài liệu đầu tiên.',
    rows: list.map((d) => {
      const latest = d.versions[0];
      const project = projectById(d.projectId);
      return {
        item: d,
        id: d.idPublic,
        title: d.title,
        docType: d.docType,
        note: d.note,
        status: d.status,
        statusLabel: DOC_STATUSES[d.status].label,
        statusBadge: DOC_STATUSES[d.status].badge,
        projectLabel: projectLabel(project),
        projectHref: project ? `/projects/${encodeURIComponent(project.idPublic)}?section=requirements` : '',
        latest: latest ? { ...latest, sizeLabel: fmtSize(latest.file.size) } : null,
        versionCount: d.versions.length,
        versions: d.versions.map((v) => ({ ...v, sizeLabel: fmtSize(v.file.size) })),
        updatedAt: d.updatedAt,
      };
    }),
    form: {
      projects: optionItems(byName(db.projects), (p) => p.idPublic, (p) => projectLabel(p), scope?.projectId ?? projectFilter),
      currentProject: scope?.projectId ?? projectFilter,
      docTypes: DOC_TYPES,
      statuses: DOC_STATUS_KEYS.map((k) => ({ key: k, label: DOC_STATUSES[k].label })),
    },
  };
}

/* ---------- Thanh toán (tổng hợp mọi dự án) ---------- */

function paymentsModel(req: Request, db: Data) {
  const projectFilter = qstr(req.query.project);
  const paidFilter = ['paid', 'unpaid'].includes(qstr(req.query.paid)) ? qstr(req.query.paid) : '';
  const q = qstr(req.query.q);
  const needle = q.toLowerCase();
  const projectById = (id: string) => db.projects.find((p) => p.idPublic === id);
  const projects = db.projects.filter((p) => !projectFilter || p.idPublic === projectFilter);
  const base = db.paymentRounds.filter((r) => !projectFilter || r.projectId === projectFilter);
  const list = base
    .filter((r) => !paidFilter || (paidFilter === 'paid' ? r.paid : !r.paid))
    .filter((r) => !needle || [r.name, r.note, projectLabel(projectById(r.projectId))].some((x) => String(x).toLowerCase().includes(needle)));
  const totalValue = projects.reduce((s, p) => s + p.totalValue, 0);
  const collected = base.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0);
  const href = (over: Record<string, string | undefined>) => `/payments${qs({ project: projectFilter, paid: paidFilter, q, ...over })}`;
  return {
    q,
    stats: {
      totalValue: money(totalValue),
      collected: money(collected),
      collectedPct: totalValue ? Math.min(100, Math.round((collected / totalValue) * 100)) : 0,
      hasTotal: totalValue > 0,
      remaining: money(Math.max(0, totalValue - collected)),
      unpaidCount: base.filter((r) => !r.paid).length,
      unpaidAmount: money(base.filter((r) => !r.paid).reduce((s, r) => s + r.amount, 0)),
      projectCount: projects.length,
    },
    tabs: [
      { label: 'Tất cả', count: base.length, active: !paidFilter, href: href({ paid: undefined }) },
      { label: 'Chưa thu', count: base.filter((r) => !r.paid).length, active: paidFilter === 'unpaid', href: href({ paid: 'unpaid' }) },
      { label: 'Đã thu', count: base.filter((r) => r.paid).length, active: paidFilter === 'paid', href: href({ paid: 'paid' }) },
    ],
    filterPaid: paidFilter,
    projectOptions: [{ value: '', label: 'Tất cả dự án', selected: !projectFilter }, ...optionItems(byName(db.projects), (p) => p.idPublic, (p) => projectLabel(p), projectFilter)],
    anyFilter: Boolean(q || paidFilter || projectFilter),
    total: list.length,
    empty: db.paymentRounds.length ? 'Không có đợt thanh toán nào khớp bộ lọc.' : 'Chưa có đợt thanh toán nào. Thêm đợt trong tab "Thanh toán" của từng dự án.',
    rows: list
      .sort((a, b) => projectLabel(projectById(a.projectId)).localeCompare(projectLabel(projectById(b.projectId)), 'vi') || a.stt - b.stt)
      .map((r) => {
        const project = projectById(r.projectId);
        return {
          ...r,
          amountLabel: money(r.amount),
          dateLabel: r.paidAt ? new Date(`${r.paidAt}T00:00:00`).toLocaleDateString('vi-VN') : '—',
          projectLabel: projectLabel(project),
          projectHref: project ? `/projects/${encodeURIComponent(project.idPublic)}?section=payments` : '',
          hasInvoice: Boolean(r.invoiceFeedbackId),
        };
      }),
  };
}

/* ---------- Nhân sự ---------- */

const ROLE_NAMES: Record<string, string> = { read: 'Chỉ đọc', write: 'Đọc + ghi', admin: 'Quản trị' };

function peopleModel(req: Request, db: Data) {
  const q = qstr(req.query.q);
  const needle = q.toLowerCase();
  const open = db.feedbacks.filter((f) => f.status !== 'done');
  const rows = db.members
    .filter((m) => !needle || [m.name, db.teams.find((t) => t.idPublic === m.teamId)?.name].some((x) => String(x || '').toLowerCase().includes(needle)))
    .map((m) => {
      const mine = db.feedbacks.filter((f) => f.assigneeId === m.idPublic);
      const openCount = mine.filter((f) => f.status !== 'done').length;
      const doingCount = mine.filter((f) => f.status === 'doing').length;
      const projects = db.projects.filter((p) => p.memberIds.includes(m.idPublic) || mine.some((f) => f.projectId === p.idPublic));
      const load =
        openCount >= 8 ? { label: 'Quá tải', badge: TONES.error.badge }
        : openCount >= 4 ? { label: 'Nhiều việc', badge: TONES.warning.badge }
        : openCount > 0 ? { label: 'Cân bằng', badge: TONES.success.badge }
        : { label: 'Đang rảnh', badge: TONES.neutral.badge };
      return {
        ...m,
        initial: m.name.slice(0, 1).toUpperCase(),
        roleLabel: ROLE_NAMES[m.role] || m.role,
        teamName: db.teams.find((t) => t.idPublic === m.teamId)?.name || '',
        projects: projects.map((p) => ({ label: projectLabel(p), href: `/projects/${encodeURIComponent(p.idPublic)}` })),
        openCount,
        doingCount,
        doneCount: mine.length - openCount,
        load,
        backlogHref: `/backlog${qs({ q: m.name })}`,
      };
    })
    .sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name, 'vi'));
  return {
    q,
    stats: {
      people: db.members.length,
      inProjects: db.members.filter((m) => db.projects.some((p) => p.memberIds.includes(m.idPublic))).length,
      assignedOpen: open.filter((f) => f.assigneeId).length,
      unassignedOpen: open.filter((f) => !f.assigneeId).length,
    },
    rows,
    empty: db.members.length ? 'Không có nhân sự nào khớp.' : 'Chưa có nhân sự. Thêm người dùng ở trang "Người dùng & token".',
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
        res.status(502).render('error', {
          tab,
          title: 'Lỗi kết nối backend',
          version: deps.version,
          heading: 'Không kết nối được backend',
          message: (e as Error).message,
          hint: 'Kiểm tra biến BACKEND_URL của frontend trỏ đúng địa chỉ backend (khác địa chỉ frontend) và backend đang chạy.',
        });
      }
    };

  app.get('/', (_req, res) => res.redirect('/dashboard'));
  // Đường dẫn cũ của màn hình mẫu
  app.get('/project', (_req, res) => res.redirect('/projects'));
  app.get('/preview', (req, res) => {
    const screen = qstr(req.query.screen);
    res.redirect(['dashboard', 'backlog', 'projects', 'teams', 'requirements', 'payments', 'people'].includes(screen) ? `/${screen}` : '/dashboard');
  });
  app.get('/dashboard', page('dashboard', 'dashboard', 'Tổng quan', deps.loadData, (req, db) => dashboardModel(db)));
  app.get('/backlog', page('backlog', 'backlog', 'Backlog', deps.loadData, backlogModel));
  app.get('/projects', page('projects', 'projects', 'Dự án', deps.loadData, projectsModel));
  app.get('/projects/:id', page('project-workspace', 'projects', 'Không gian dự án', deps.loadData, projectWorkspaceModel));
  app.get('/teams', page('teams', 'teams', 'Team xử lý', deps.loadData, teamsModel));
  app.get('/requirements', page('requirements', 'requirements', 'Tài liệu PTYC', deps.loadData, (req, db) => documentsModel(req, db)));
  app.get('/payments', page('payments', 'payments', 'Thanh toán', deps.loadData, paymentsModel));
  app.get('/people', page('people', 'people', 'Nhân sự', deps.loadData, peopleModel));
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
