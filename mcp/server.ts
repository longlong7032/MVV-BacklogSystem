#!/usr/bin/env node
/**
 * MCP server cho Feedback backlog — để dev (Claude Code, Cursor, ...) đọc backlog lỗi,
 * xem ảnh / HAR rồi tự sửa code, và cập nhật trạng thái.
 *
 * Hai cách chạy:
 *  1. HTTP (khuyến nghị khi deploy): server.js của web app mount sẵn tại  POST /mcp  (xem createMcpServer).
 *  2. stdio (chạy riêng trên máy dev):  node mcp/server.js
 *       BACKLOG_URL       địa chỉ web app (mặc định http://localhost:3000)
 *       BACKLOG_READONLY  =1 để tắt các tool ghi
 *     (chế độ stdio nói chuyện thẳng với API, không đi qua xác thực token của /mcp)
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { version } = createRequire(import.meta.url)('../package.json');

const STATUS_LABEL = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Đã hoàn thành' };
const STATUS = z.enum(['todo', 'doing', 'done']);

const norm = (s) => String(s || '').trim().toLowerCase();
const findByIdOrName = (list, key) => {
  const k = norm(key);
  return (
    list.find((x) => x.id === key) ||
    list.find((x) => x.code && norm(x.code) === k) || // mã dự án
    list.find((x) => norm(x.name) === k) ||
    list.find((x) => norm(x.name).includes(k))
  );
};
// Giới hạn để một lời gọi không làm tràn bộ nhớ / băng thông
const FETCH_TIMEOUT_MS = 15000;
const MAX_OUTPUT_CHARS = 100000; // kết quả text trả cho model
const MAX_HAR_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_HAR_ROWS = 50; // số request lỗi / chậm / api trả về tối đa mỗi nhóm

const clip = (s) => (s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n… (đã cắt, còn ${s.length - MAX_OUTPUT_CHARS} ký tự)` : s);
const text = (obj) => ({ content: [{ type: 'text', text: clip(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) }] });

// Đọc body có chặn dung lượng (không tin content-length)
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`file quá lớn (${Math.round(declared / 1048576)}MB > ${Math.round(maxBytes / 1048576)}MB)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`file quá lớn (> ${Math.round(maxBytes / 1048576)}MB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

/**
 * Backend qua HTTP: nói chuyện với web app đang chạy ở nơi khác (chế độ stdio trên máy dev).
 * Trong server.js (Vercel / chạy chung tiến trình) dùng backend đọc thẳng dữ liệu, không cần HTTP.
 */
function createHttpBackend(apiBase) {
  const API = apiBase.replace(/\/+$/, '');

  async function http(path, options = {}) {
    let res;
    try {
      res = await fetch(API + path, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      throw new Error(`Không kết nối được tới ${API} (${e.message}).`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status} khi gọi ${path}`);
    }
    return res;
  }
  const getJson = async (path) => (await http(path)).json();
  const patch = async (path, body) =>
    (await http(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  return {
    async loadAll() {
      const [projects, teams, feedbacks] = await Promise.all([
        getJson('/api/projects'),
        getJson('/api/teams'),
        getJson('/api/feedbacks'),
      ]);
      return { projects, teams, feedbacks };
    },
    async fetchFile(url, maxBytes) {
      const res = await http(url);
      const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      return { buffer: await readLimited(res, maxBytes), mime };
    },
    setStatus: (id, status) => patch(`/api/feedbacks/${id}/status`, { status }),
    assignTeam: (id, teamId) => patch(`/api/feedbacks/${id}/team`, { team_id: teamId }),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.backend      nguồn dữ liệu: { loadAll(), fetchFile(url, maxBytes), setStatus(id, status), assignTeam(id, teamId) }
 * @param {string} opts.publicBase   địa chỉ công khai để dựng link ảnh / HAR trả cho dev
 * @param {boolean} [opts.canWrite]  có đăng ký tool ghi (đổi trạng thái / giao team) hay không
 */
function createMcpServer({ backend, publicBase, canWrite = true }) {
  const PUBLIC = publicBase.replace(/\/+$/, '');
  const abs = (u) => (u ? PUBLIC + u : '');
  const loadAll = () => backend.loadAll();

  function brief(f, ctx) {
    const project = ctx.projects.find((p) => p.id === f.projectId);
    const team = ctx.teams.find((t) => t.id === f.teamId);
    return {
      id: f.id,
      ref: `${project ? project.code || project.name : '?'}#${f.stt}`,
      project_code: project && project.code ? project.code : null,
      project: project ? project.name : null,
      type: f.type || null,
      title: f.title || null,
      stt: f.stt,
      status: f.status,
      status_label: STATUS_LABEL[f.status],
      team: team ? team.name : null,
      location_url: f.location.url || null,
      bug: f.bug.text.length > 200 ? f.bug.text.slice(0, 200) + '…' : f.bug.text,
      images: (f.location.image ? 1 : 0) + f.bug.images.length + f.expected.images.length,
      has_har: Boolean(f.har),
      created_at: f.createdAt,
      updated_at: f.updatedAt,
    };
  }

  function detail(f, ctx) {
    return {
      ...brief(f, ctx),
      bug: f.bug.text,
      expected: f.expected.text,
      note: f.note || null,
      location: { url: f.location.url || null, image: abs(f.location.image) || null },
      bug_images: f.bug.images.map(abs),
      expected_images: f.expected.images.map(abs),
      har: f.har ? { url: abs(f.har.url), name: f.har.name, size: f.har.size } : null,
      completed_at: f.completedAt,
    };
  }

  // Tìm 1 backlog theo id, hoặc theo (project + stt)
  function resolveBacklog(ctx, { id, project, stt }) {
    if (id) {
      const matches = ctx.feedbacks.filter((f) => f.id === id || f.id.startsWith(id));
      if (matches.length === 1) return { item: matches[0] };
      return { error: matches.length ? `id "${id}" khớp nhiều backlog, hãy dùng id đầy đủ.` : `Không có backlog id "${id}".` };
    }
    if (project && stt) {
      const p = findByIdOrName(ctx.projects, project);
      if (!p) return { error: `Không tìm thấy dự án "${project}".` };
      const item = ctx.feedbacks.find((f) => f.projectId === p.id && f.stt === stt);
      return item ? { item } : { error: `Dự án "${p.name}" không có backlog STT ${stt}.` };
    }
    return { error: 'Cần truyền "id", hoặc cả "project" và "stt".' };
  }

  const server = new McpServer({ name: 'feedback-backlog', version });

  server.registerTool(
    'list_projects',
    { description: 'Liệt kê các dự án kèm số backlog theo trạng thái.', inputSchema: {} },
    async () => {
      const ctx = await loadAll();
      return text(
        ctx.projects.map((p) => {
          const items = ctx.feedbacks.filter((f) => f.projectId === p.id);
          const n = (s) => items.filter((f) => f.status === s).length;
          return { id: p.id, name: p.name, code: p.code || null, description: p.description, total: items.length, todo: n('todo'), doing: n('doing'), done: n('done') };
        })
      );
    }
  );

  server.registerTool(
    'list_teams',
    { description: 'Liệt kê các team xử lý kèm số backlog đang giao.', inputSchema: {} },
    async () => {
      const ctx = await loadAll();
      return text(
        ctx.teams.map((t) => {
          const items = ctx.feedbacks.filter((f) => f.teamId === t.id);
          return {
            id: t.id,
            name: t.name,
            lead: t.lead,
            description: t.description,
            open: items.filter((f) => f.status !== 'done').length,
            total: items.length,
          };
        })
      );
    }
  );

  server.registerTool(
    'list_backlog',
    {
      description:
        'Liệt kê backlog lỗi (dạng rút gọn), có thể lọc theo dự án / team / trạng thái / từ khóa. ' +
        'Dùng get_backlog để xem đầy đủ một mục. Ví dụ "team kĩ thuật đang chưa làm": team="kĩ thuật", status="todo".',
      inputSchema: {
        project: z.string().max(200).optional().describe('Mã dự án, tên hoặc id dự án'),
        type: z.string().max(60).optional().describe('Loại, vd "App customer", "Website admin"; "none" = chưa phân loại'),
        team: z.string().max(200).optional().describe('Tên hoặc id team; "none" = chưa phân công'),
        status: STATUS.optional().describe('todo | doing | done'),
        query: z.string().max(200).optional().describe('Từ khóa tìm trong tên lỗi / mô tả lỗi / kết quả mong muốn / ghi chú / URL'),
        limit: z.number().int().min(1).max(200).default(50).describe('Số lượng tối đa (mặc định 50)'),
      },
    },
    async ({ project, type, team, status, query, limit }) => {
      const ctx = await loadAll();
      let list = ctx.feedbacks;

      if (project) {
        const p = findByIdOrName(ctx.projects, project);
        if (!p) return fail(`Không tìm thấy dự án "${project}". Dùng list_projects để xem danh sách.`);
        list = list.filter((f) => f.projectId === p.id);
      }
      if (team) {
        if (norm(team) === 'none') list = list.filter((f) => !f.teamId);
        else {
          const t = findByIdOrName(ctx.teams, team);
          if (!t) return fail(`Không tìm thấy team "${team}". Dùng list_teams để xem danh sách.`);
          list = list.filter((f) => f.teamId === t.id);
        }
      }
      if (status) list = list.filter((f) => f.status === status);
      if (type) list = list.filter((f) => (norm(type) === 'none' ? !f.type : norm(f.type) === norm(type)));
      if (query) {
        const q = norm(query);
        list = list.filter((f) => [f.title, f.bug.text, f.expected.text, f.note, f.location.url].some((s) => norm(s).includes(q)));
      }

      const order = { doing: 0, todo: 1, done: 2 };
      list = [...list].sort((a, b) => order[a.status] - order[b.status] || a.stt - b.stt);
      return text({ total: list.length, shown: Math.min(list.length, limit), items: list.slice(0, limit).map((f) => brief(f, ctx)) });
    }
  );

  server.registerTool(
    'get_backlog',
    {
      description:
        'Lấy chi tiết đầy đủ một backlog: mã + tên dự án, loại, team, tên lỗi, vị trí lỗi, mô tả lỗi, kết quả mong muốn, ghi chú, link ảnh, file HAR. ' +
        'Đặt include_images=true để nhận luôn ảnh (hiển thị được cho model). Chỉ định bằng id, hoặc project + stt.',
      inputSchema: {
        id: z.string().max(64).optional().describe('Id backlog (đủ hoặc tiền tố duy nhất)'),
        project: z.string().max(200).optional().describe('Mã hoặc tên dự án (dùng cùng stt)'),
        stt: z.number().int().min(1).max(1000000).optional().describe('STT trong dự án'),
        include_images: z.boolean().default(false).describe('Đính kèm ảnh (tối đa 6 ảnh)'),
      },
    },
    async ({ id, project, stt, include_images }) => {
      const ctx = await loadAll();
      const { item, error } = resolveBacklog(ctx, { id, project, stt });
      if (error) return fail(error);

      const content = [{ type: 'text', text: JSON.stringify(detail(item, ctx), null, 2) }];
      if (include_images) {
        const urls = [item.location.image, ...item.bug.images, ...item.expected.images].filter(Boolean).slice(0, 6);
        let total = 0;
        for (const url of urls) {
          try {
            const { buffer: buf, mime: mimeType } = await backend.fetchFile(url, MAX_IMAGE_BYTES);
            if (!mimeType.startsWith('image/')) throw new Error('không phải ảnh');
            total += buf.length;
            if (total > MAX_IMAGES_TOTAL_BYTES) {
              content.push({ type: 'text', text: 'Đã đạt giới hạn dung lượng ảnh, bỏ qua các ảnh còn lại (xem link trong JSON).' });
              break;
            }
            content.push({ type: 'text', text: `Ảnh: ${abs(url)}` });
            content.push({ type: 'image', data: buf.toString('base64'), mimeType });
          } catch (e) {
            content.push({ type: 'text', text: `Không tải được ảnh ${abs(url)}: ${e.message}` });
          }
        }
      }
      return { content };
    }
  );

  server.registerTool(
    'analyze_har',
    {
      description:
        'Phân tích file HAR (network log) đính kèm backlog: liệt kê request lỗi (status >= 400 hoặc thất bại), ' +
        'request chậm, kèm request/response body rút gọn. Dùng để tìm API gây lỗi.',
      inputSchema: {
        id: z.string().max(64).optional(),
        project: z.string().max(200).optional(),
        stt: z.number().int().min(1).max(1000000).optional(),
        slow_ms: z.number().min(0).max(600000).default(2000).describe('Ngưỡng coi là chậm (ms)'),
        include_all: z.boolean().default(false).describe('Liệt kê toàn bộ request XHR/fetch thay vì chỉ lỗi / chậm'),
      },
    },
    async ({ id, project, stt, slow_ms, include_all }) => {
      const ctx = await loadAll();
      const { item, error } = resolveBacklog(ctx, { id, project, stt });
      if (error) return fail(error);
      if (!item.har) return fail('Backlog này không có file HAR.');

      let har;
      try {
        har = JSON.parse((await backend.fetchFile(item.har.url, MAX_HAR_BYTES)).buffer.toString('utf8'));
      } catch (e) {
        return fail(`Không đọc được file HAR: ${e.message}`);
      }
      const entries = (har.log && har.log.entries) || [];
      const cut = (s, n = 600) => (s && s.length > n ? s.slice(0, n) + `… (+${s.length - n} ký tự)` : s || '');
      const row = (e) => ({
        method: e.request.method,
        url: e.request.url,
        status: e.response.status,
        status_text: e.response.statusText,
        time_ms: Math.round(e.time),
        type: e._resourceType || (e.response.content && e.response.content.mimeType) || '',
        request_body: cut(e.request.postData && e.request.postData.text),
        response_body: cut(e.response.content && e.response.content.text),
      });

      const failed = entries.filter((e) => e.response.status >= 400 || e.response.status === 0);
      const slow = entries.filter((e) => e.time >= slow_ms && !failed.includes(e));
      const xhr = entries.filter((e) => /^(xhr|fetch)$/i.test(e._resourceType || '') || /json/i.test((e.response.content || {}).mimeType || ''));

      return text({
        har: item.har.name,
        total_requests: entries.length,
        failed_count: failed.length,
        failed: failed.slice(0, MAX_HAR_ROWS).map(row),
        slow_count: slow.length,
        slow: slow.slice(0, MAX_HAR_ROWS).map(row),
        ...(include_all ? { api_requests: xhr.slice(0, MAX_HAR_ROWS).map(row) } : {}),
        ...(failed.length > MAX_HAR_ROWS || slow.length > MAX_HAR_ROWS ? { note: `Mỗi nhóm chỉ hiển thị ${MAX_HAR_ROWS} request đầu.` } : {}),
      });
    }
  );

  if (canWrite) {
    server.registerTool(
      'update_backlog_status',
      {
        description:
          'Cập nhật trạng thái backlog (todo = chưa làm, doing = đang làm, done = đã hoàn thành). ' +
          'Gọi với doing khi bắt đầu sửa và done khi đã sửa xong.',
        inputSchema: {
          id: z.string().max(64).optional(),
          project: z.string().max(200).optional(),
          stt: z.number().int().min(1).max(1000000).optional(),
          status: STATUS,
        },
      },
      async ({ id, project, stt, status }) => {
        const ctx = await loadAll();
        const { item, error } = resolveBacklog(ctx, { id, project, stt });
        if (error) return fail(error);
        return text(brief(await backend.setStatus(item.id, status), ctx));
      }
    );

    server.registerTool(
      'assign_backlog_team',
      {
        description: 'Giao backlog cho một team xử lý (team = tên hoặc id; "none" để bỏ phân công).',
        inputSchema: {
          id: z.string().max(64).optional(),
          project: z.string().max(200).optional(),
          stt: z.number().int().min(1).max(1000000).optional(),
          team: z.string().max(200),
        },
      },
      async ({ id, project, stt, team }) => {
        const ctx = await loadAll();
        const { item, error } = resolveBacklog(ctx, { id, project, stt });
        if (error) return fail(error);
        let teamId = '';
        if (norm(team) !== 'none') {
          const t = findByIdOrName(ctx.teams, team);
          if (!t) return fail(`Không tìm thấy team "${team}".`);
          teamId = t.id;
        }
        return text(brief(await backend.assignTeam(item.id, teamId), ctx));
      }
    );
  }

  return server;
}

export { createMcpServer, createHttpBackend };

/* ---------- Chế độ stdio (chạy trực tiếp: node mcp/server.js) ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.BACKLOG_URL || 'http://localhost:3000';
  createMcpServer({
    backend: createHttpBackend(base),
    publicBase: base,
    canWrite: process.env.BACKLOG_READONLY !== '1',
  })
    .connect(new StdioServerTransport())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
