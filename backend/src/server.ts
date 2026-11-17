/**
 * Feedback backlog — BACKEND: API JSON + file tải lên + MCP. Không render giao diện (xem project `frontend/`).
 *
 *  - Dữ liệu: Postgres (bảng thật, xem db/migrations.ts). Mọi request ghi chạy trong một transaction (db/pool.ts).
 *  - API theo module: modules/*.ts (dự án, team, backlog, thanh toán, tài liệu PTYC, người dùng, nhật ký).
 *  - Quy ước: API chỉ dùng `idPublic` (UUID v7); xóa = xóa mềm (`deleted_at`).
 *  - MCP (Streamable HTTP) cho Claude Code / Cursor tại POST /mcp.
 */
import './lib/env.js'; // phải import đầu tiên để nạp .env trước khi các module khác đọc biến môi trường
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ROOT_DIR } from './lib/paths.js';
import { HttpError, route, uuidParam } from './lib/http.js';
import { blobMode, readFile } from './lib/blobs.js';
import { MAX_REQUEST_BYTES } from './lib/upload.js';
import { q1, tx, txMiddleware } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createMcpServer } from './mcp/server.js';
import type { Backend } from './mcp/server.js';
import { activityRouter, listActivity } from './modules/activity.js';
import { teamsRouter, listTeams } from './modules/teams.js';
import { projectsRouter, listProjects } from './modules/projects.js';
import { feedbacksRouter, getBacklogStats, listFeedbacks, setFeedbackStatus, assignFeedbackTeam } from './modules/feedbacks.js';
import { paymentsRouter, listPayments } from './modules/payments.js';
import { documentsRouter, listDocuments } from './modules/documents.js';
import { projectTokensRouter, findProjectToken, touchProjectToken } from './modules/project-tokens.js';
import { usersRouter, listProjectMembers, makeLimiter, findUserByToken, touchLastUsed, bearer, DEV_NO_AUTH } from './modules/users.js';
import type { McpInfo } from './types.js';

const { version } = createRequire(import.meta.url)(path.join(ROOT_DIR, 'package.json')) as { version: string };
const app = express();
const PORT = process.env.PORT || 3000;

// Số proxy tin cậy phía trước app (nginx / Vercel = 1). Không có proxy thì đặt TRUST_PROXY=0.
const trustProxy: number | string =
  process.env.TRUST_PROXY === undefined ? 1 : /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '256kb' }));

/* ---------- Khởi tạo: migrate schema (một lần mỗi instance; lỗi thì thử lại ở request sau) ---------- */
let readyPromise: Promise<void> | null = null;
const ensureReady = (): Promise<void> =>
  (readyPromise ||= (async () => {
    await runMigrations();
  })().catch((e) => {
    readyPromise = null;
    throw e;
  }));

app.use(['/api', '/mcp', '/uploads'], (req, res, next) => {
  ensureReady().then(
    () => next(),
    (e: Error) => {
      console.error('[db] khởi tạo thất bại:', e.message);
      res.status(503).json({ error: 'Không khởi tạo được cơ sở dữ liệu, vui lòng thử lại sau.' });
    }
  );
});

/* ---------- File tải lên ---------- */
app.get(
  '/uploads/:name',
  route(async (req, res) => {
    const name = path.basename(req.params.name as string);
    if (!/^[\w.-]+$/.test(name)) return void res.status(404).end(); // chống path traversal
    const file = await readFile(name);
    if (!file) return void res.status(404).end();
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (!/^image\//.test(file.mime)) res.setHeader('Content-Disposition', 'attachment');
    res.end(file.buffer);
  })
);

/* ---------- API ---------- */
const DEV_NO_AUTH_INFO = DEV_NO_AUTH;
const MCP_READONLY = process.env.MCP_READONLY === '1';
const mcpInfo = (): McpInfo => ({
  enabled: true,
  authRequired: !DEV_NO_AUTH_INFO,
  readonly: MCP_READONLY,
  // Vercel giới hạn body ~4.5MB / request; chạy local (không có VERCEL) thì không giới hạn
  maxUploadBytes: process.env.VERCEL ? MAX_REQUEST_BYTES : 0,
});

const api = express.Router();
api.use(txMiddleware); // POST/PUT/PATCH/DELETE: một transaction / request
// Gộp dữ liệu mà một trang cần vào MỘT request (serverless: 1 lần gọi thay vì nhiều lần, mỗi lần có thể cold start).
//   ?parts=projects,teams,feedbacks,...  chỉ chạy truy vấn của các phần được yêu cầu (bỏ trống = tất cả)
//   ?project=<idPublic>                  giới hạn feedbacks / activity / paymentRounds / documents theo một dự án
const BOOTSTRAP_LOADERS = {
  projects: () => listProjects(),
  teams: () => listTeams(),
  members: () => listProjectMembers(),
  feedbacks: (project: string) => listFeedbacks(project),
  activity: (project: string) => listActivity(project),
  paymentRounds: (project: string) => listPayments(project),
  documents: (project: string) => listDocuments(project),
  stats: () => getBacklogStats(),
} as const;
api.get(
  '/bootstrap',
  route(async (req, res) => {
    const asked = String(req.query.parts || '').split(',').map((x) => x.trim()).filter(Boolean);
    const keys = (asked.length ? asked : Object.keys(BOOTSTRAP_LOADERS)).filter((k): k is keyof typeof BOOTSTRAP_LOADERS => k in BOOTSTRAP_LOADERS);
    const project = uuidParam(req.query.project);
    const out: Record<string, unknown> = { projects: [], teams: [], feedbacks: [], activity: [], paymentRounds: [], members: [], documents: [], stats: { groups: [], nextStt: {}, types: [] } };
    await Promise.all(keys.map(async (k) => void (out[k] = await BOOTSTRAP_LOADERS[k](project))));
    res.json(out);
  })
);
api.get('/mcp-info', (req, res) => void res.json(mcpInfo()));
for (const router of [projectsRouter, teamsRouter, feedbacksRouter, paymentsRouter, documentsRouter, activityRouter, usersRouter, projectTokensRouter]) api.use(router);
api.use((req, res) => void res.status(404).json({ error: 'Không có API này.' }));
app.use('/api', api);

/* ---------- MCP (Streamable HTTP) ---------- */
// Dev kết nối: claude mcp add --transport http feedback-backlog https://<host>/mcp --header "Authorization: Bearer <token cá nhân>"
// Bảo mật: token cá nhân bắt buộc (trừ DEV_NO_AUTH), quyền theo user (read / write), giới hạn tốc độ + khóa IP khi sai token,
// giới hạn request đồng thời. MCP_READONLY=1 ép chỉ đọc. PUBLIC_URL: địa chỉ công khai để dựng link ảnh / HAR.
const mcpPerIp = makeLimiter(60, 60 * 1000);
const mcpGlobal = makeLimiter(300, 60 * 1000);
const mcpBadAuth = makeLimiter(8, 15 * 60 * 1000);
const MCP_MAX_CONCURRENT = 8;
const MCP_REQUEST_TIMEOUT = 60 * 1000;
let mcpActive = 0;

/** Nguồn dữ liệu cho MCP: gọi thẳng các module (ghi trong transaction riêng). */
const directBackend = (actor: string, scope: string[] | null): Backend => {
  const allowed = (projectPublicId: string): boolean => scope === null || scope.includes(projectPublicId);
  /** Chặn đổi backlog ngoài phạm vi token (kể cả khi biết id). */
  const guard = async (feedbackPublicId: string): Promise<void> => {
    if (scope === null) return;
    const row = await q1<{ pid: string }>('SELECT p.id_public AS pid FROM feedbacks f JOIN projects p ON p.id_private = f.project_id WHERE f.id_public = $1::uuid AND f.deleted_at IS NULL', [feedbackPublicId]).catch(() => null);
    if (!row || !allowed(row.pid)) throw new Error('Không tìm thấy backlog (hoặc token này không có quyền với dự án của backlog).');
  };
  return {
  async loadAll() {
    const [projects, teams, feedbacks] = await Promise.all([listProjects(), listTeams(), listFeedbacks()]);
    // Token theo dự án / người dùng thường: chỉ thấy dự án được cấp (scope = null: admin, thấy tất cả)
    return scope === null ? { projects, teams, feedbacks } : { projects: projects.filter((p) => allowed(p.idPublic)), teams, feedbacks: feedbacks.filter((f) => allowed(f.projectId)) };
  },
  async fetchFile(url, maxBytes) {
    const file = await readFile(path.basename(String(url)));
    if (!file) throw new Error('Không tìm thấy file.');
    if (file.buffer.length > maxBytes) throw new Error(`file quá lớn (> ${Math.round(maxBytes / 1048576)}MB)`);
    return file;
  },
  setStatus: async (id, status) => (await guard(id), tx(() => setFeedbackStatus(id, status, actor || 'MCP', true))),
  assignTeam: async (id, teamId) => (await guard(id), tx(() => assignFeedbackTeam(id, teamId, actor || 'MCP', true))),
  };
};

const rpcError = (res: Response, code: number, message: string): Response => res.status(code).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
const tooMany = (res: Response, seconds: number): Response => {
  res.setHeader('Retry-After', String(seconds));
  return rpcError(res, 429, `Quá nhiều yêu cầu, thử lại sau ${seconds}s.`);
};

app.post(
  '/mcp',
  route(async (req, res) => {
    const ip = req.ip || 'unknown';
    const locked = mcpBadAuth.over(ip);
    if (locked) return void tooMany(res, locked);
    const wait = mcpPerIp.hit(ip) || mcpGlobal.hit('all');
    if (wait) return void tooMany(res, wait);

    let actor = 'local';
    let canWrite = true;
    let scope: string[] | null = null; // null = xem mọi dự án; còn lại = danh sách id dự án được xem
    if (!DEV_NO_AUTH) {
      const credential = bearer(req);
      const projectToken = await findProjectToken(credential);
      const user = projectToken ? projectToken.actor : await findUserByToken(credential);
      if (!user) {
        mcpBadAuth.hit(ip);
        res.setHeader('WWW-Authenticate', 'Bearer');
        return void rpcError(res, 401, 'Thiếu hoặc sai token (header Authorization: Bearer <token cá nhân>).');
      }
      if (!user.active) return void rpcError(res, 403, 'Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên.');
      actor = user.name;
      canWrite = user.role === 'write' || user.role === 'admin';
      // Token dự án chỉ xem đúng dự án đó; token cá nhân của admin xem tất cả; của người dùng thường chưa gán dự án thì không xem được gì
      scope = projectToken ? [projectToken.projectPublicId] : user.role === 'admin' ? null : [];
      if (projectToken) await touchProjectToken(projectToken.tokenId);
      else await touchLastUsed(user.idPrivate);
    }
    if (MCP_READONLY) canWrite = false;

    if (mcpActive >= MCP_MAX_CONCURRENT) return void tooMany(res, 5);
    mcpActive++;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        mcpActive--;
      }
    };
    res.setTimeout(MCP_REQUEST_TIMEOUT, () => {
      release();
      if (!res.headersSent) rpcError(res, 504, 'MCP xử lý quá thời gian.');
      res.end();
    });
    try {
      const server = createMcpServer({ backend: directBackend(actor, scope), publicBase: process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`, canWrite });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
      res.on('close', () => {
        release();
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      release();
      console.error('MCP error:', e);
      if (!res.headersSent) rpcError(res, 500, 'Lỗi MCP nội bộ.');
    }
  })
);
app.all('/mcp', (req, res) => void rpcError(res, 405, 'Chỉ hỗ trợ POST.'));

/* ---------- Sức khỏe ---------- */
app.get(['/', '/health'], (req, res) => void res.json({ name: 'feedback-backlog-backend', version, storage: 'postgres', files: blobMode() }));

/* ---------- Xử lý lỗi ---------- */
app.use((err: Error & { code?: string; status?: number }, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err.code === 'LIMIT_FILE_SIZE') return void res.status(400).json({ error: 'File vượt quá 50MB.' });
  if (err.code === '23505') return void res.status(409).json({ error: 'Dữ liệu bị trùng, vui lòng tải lại trang và thử lại.' });
  if (err.code === '22P02') return void res.status(400).json({ error: 'Định dạng dữ liệu không hợp lệ.' });
  if ((err as { type?: string }).type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON không hợp lệ.' });
  console.error('[api] lỗi:', err);
  res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau.' });
});

process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

export default app;

// Chạy trực tiếp (npm start / npm run dev): mở cổng. Trên Vercel, api/index.js import app.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureReady()
    .then(() => app.listen(PORT, () => console.log(`Feedback backlog chạy tại http://localhost:${PORT} (Postgres, file: ${blobMode()})`)))
    .catch((e) => {
      console.error('Không khởi động được:', e.message);
      process.exit(1);
    });
}
