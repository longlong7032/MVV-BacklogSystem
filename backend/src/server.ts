/**
 * Feedback backlog — BACKEND: máy chủ Express chỉ phục vụ API JSON, file tải lên và MCP.
 * Không render giao diện; giao diện nằm ở project `frontend/` và gọi tới đây qua HTTP.
 *
 * Các phần chính (theo thứ tự trong file):
 *  1. Cấu hình Express (header bảo mật, trust proxy, JSON body).
 *  2. Mô hình dữ liệu + `migrate` (chuẩn hóa dữ liệu cũ) + khởi tạo lưu trữ.
 *  3. Upload ảnh / HAR (multer) và API: dự án, team, backlog, xuất Excel.
 *  4. Bảo mật: giới hạn tốc độ, đăng nhập quản trị, người dùng + token cá nhân.
 *  5. MCP (Streamable HTTP) cho Claude Code / Cursor.
 *  6. Điểm kiểm tra sức khỏe, xử lý lỗi và khởi động (chạy trực tiếp hoặc export `app` cho Vercel).
 */
import './lib/env.js'; // phải import đầu tiên để nạp .env trước khi các module khác đọc biến môi trường
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOKEN_PREFIX, newToken, sha256, hashToken, tokenHint, hashPassword, verifyPassword } from './lib/tokens.js';
import { createMcpServer } from './mcp/server.js';
import { compressImage } from './lib/image.js';
import { createStore, runInRequestStore, readDb, writeDb, isLocked, queueUpload, queueFileDelete } from './lib/store.js';
import { ROOT_DIR } from './lib/paths.js';
import type { Backend } from './mcp/server.js';
import type { AuditEntry, Database, Feedback, FeedbackStatus, McpInfo, Project, PublicUser, Role, Team, User } from './types.js';

/* ---------- Kiểu dữ liệu nội bộ ---------- */

/** Kết quả kiểm tra dữ liệu đầu vào không hợp lệ. */
interface ValidationError {
  error: string;
}

/** Các file multer nhận được, nhóm theo tên field của form. */
type UploadedFiles = Record<string, Express.Multer.File[]>;

/** Quản trị viên đang thực hiện request (gắn vào `req.admin` sau khi qua `requireAdmin`). */
interface AdminActor {
  id: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminActor;
    }
  }
}

/** Bộ giới hạn tốc độ cửa sổ cố định, lưu trong bộ nhớ. */
interface Limiter {
  /** Ghi nhận 1 lần gọi; trả về số giây phải chờ nếu vượt giới hạn, ngược lại 0. */
  hit(key: string): number;
  /** Chỉ kiểm tra (không ghi nhận); trả về số giây còn bị khóa, hoặc 0. */
  over(key: string): number;
}

// package.json nằm ở thư mục gốc dự án (ROOT_DIR đúng cả khi chạy từ nguồn lẫn từ dist/)
const { version } = createRequire(import.meta.url)(path.join(ROOT_DIR, 'package.json')) as { version: string };

const app = express();
const PORT = process.env.PORT || 4000;

// DATA_DIR / UPLOAD_DIR: đổi nơi lưu dữ liệu và ảnh (dùng khi deploy hoặc chạy thử mà không đụng dữ liệu thật)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT_DIR, 'uploads');

/* ---------- View engine ---------- */
// Số proxy tin cậy phía trước app (nginx = 1). Không có proxy thì đặt TRUST_PROXY=0 để IP không bị giả mạo qua X-Forwarded-For.
const trustProxy: number | string =
  process.env.TRUST_PROXY === undefined
    ? 1
    : /^\d+$/.test(process.env.TRUST_PROXY)
      ? Number(process.env.TRUST_PROXY)
      : process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy);
app.disable('x-powered-by');
// Header bảo mật cơ bản cho mọi phản hồi
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/* ---------- Body ---------- */
app.use(express.json({ limit: '256kb' }));

/* ---------- Helpers ---------- */
/** Các trạng thái hợp lệ: Chưa làm / Đang làm / Đã hoàn thành. */
const STATUSES: FeedbackStatus[] = ['todo', 'doing', 'done'];
/** Type guard: chuỗi có phải trạng thái hợp lệ không. */
const isStatus = (v: string): v is FeedbackStatus => (STATUSES as string[]).includes(v);

/** Ép giá trị bất kỳ về chuỗi đã cắt khoảng trắng; không phải chuỗi -> ''. */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** Thời điểm hiện tại dạng ISO-8601. */
const now = (): string => new Date().toISOString();
/** So sánh hai tên không phân biệt hoa/thường và dấu (theo locale tiếng Việt). */
const sameName = (a: string, b: string): boolean => a.localeCompare(b, 'vi', { sensitivity: 'base' }) === 0;

/** Tạo bản ghi team mới với id ngẫu nhiên. */
function newTeam(name: string, lead = '', description = ''): Team {
  return { id: crypto.randomUUID(), name, lead, description, createdAt: now(), updatedAt: now() };
}

/** Tạo bản ghi dự án mới với id ngẫu nhiên. */
function newProject(name: string, description = '', code = ''): Project {
  return { id: crypto.randomUUID(), code, name, description, createdAt: now(), updatedAt: now() };
}

/* ---------- Mini DB (JSON file) ---------- */
/**
 * Chuẩn hóa dữ liệu đọc từ DB (có thể là bản cũ hoặc rỗng): đảm bảo đủ các mảng/trường,
 * feedback cũ lưu tên dự án (`project`) -> tạo bản ghi dự án và gắn `projectId`, thêm trạng thái mặc định.
 * Dữ liệu thô chưa được tin cậy nên tham số dùng `any`; kết quả trả về là `Database` đã hợp lệ.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrate(raw: Record<string, any>): Database {
  const db = raw as any;
  // 1) Bảo đảm đủ các mảng/đối tượng gốc
  db.projects = Array.isArray(db.projects) ? db.projects : [];
  db.teams = Array.isArray(db.teams) ? db.teams : [];
  db.users = Array.isArray(db.users) ? db.users : [];
  db.audit = Array.isArray(db.audit) ? db.audit : [];
  db.sessions = db.sessions && typeof db.sessions === 'object' && !Array.isArray(db.sessions) ? db.sessions : {};
  // 2) Người dùng trỏ tới team đã bị xóa -> bỏ liên kết
  for (const u of db.users) if (u.teamId && !db.teams.some((t: Team) => t.id === u.teamId)) u.teamId = '';
  db.feedbacks = Array.isArray(db.feedbacks) ? db.feedbacks : [];
  // 3) Dự án cũ chưa có mã -> mã rỗng
  for (const p of db.projects) if (typeof p.code !== 'string') p.code = '';

  // 4) Chuẩn hóa từng backlog
  for (const f of db.feedbacks) {
    // Backlog cũ lưu tên dự án (f.project): tìm hoặc tạo dự án tương ứng rồi gắn projectId
    if (!f.projectId || !db.projects.some((p: Project) => p.id === f.projectId)) {
      const name = str(f.project) || 'Chưa phân loại';
      let project = db.projects.find((p: Project) => sameName(p.name, name));
      if (!project) {
        project = newProject(name);
        db.projects.push(project);
      }
      f.projectId = project.id;
    }
    delete f.project;
    // Trạng thái, HAR, chuỗi văn bản và team phải luôn hợp lệ
    if (!STATUSES.includes(f.status)) f.status = 'todo';
    if (!f.har) f.har = null;
    for (const k of ['title', 'type', 'note']) if (typeof f[k] !== 'string') f[k] = '';
    if (!f.teamId || !db.teams.some((t: Team) => t.id === f.teamId)) f.teamId = '';
  }
  return db as Database;
}

/* ---------- Lưu trữ: Postgres (có biến DATABASE_URL / POSTGRES_URL...) hoặc file JSON (local) ---------- */
const storage = createStore({ migrate, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR });

// Khởi tạo (tạo bảng + admin cứng) một lần cho mỗi instance; lỗi thì cho thử lại ở request sau
let readyPromise: Promise<void> | null = null;
const ensureReady = (): Promise<void> =>
  (readyPromise ||= (async () => {
    await storage.init();
    await storage.withStore(true, seedAdmin);
  })().catch((e) => {
    readyPromise = null;
    throw e;
  }));

// Mọi request chạm tới dữ liệu phải chờ khởi tạo xong (tạo bảng + admin cứng)
app.use(['/api', '/mcp', '/uploads'], (req, res, next) => {
  ensureReady().then(
    () => next(),
    (e: Error) => {
      console.error('[db] khởi tạo thất bại:', e.message);
      res.status(503).json({ error: 'Không khởi tạo được cơ sở dữ liệu, vui lòng thử lại sau.' });
    }
  );
});
app.use('/api', storage.dbContext()); // GET: chỉ đọc · POST/PUT/PATCH/DELETE: transaction + khóa dòng
app.use('/mcp', storage.dbContext({ lock: false })); // MCP tự mở transaction riêng khi cần ghi

// File tải lên (ảnh, HAR): đọc từ Postgres (Vercel) hoặc thư mục uploads (local)
app.get('/uploads/:name', async (req, res, next) => {
  try {
    const name = path.basename(req.params.name);
    // Chỉ cho phép tên file an toàn (chống path traversal)
    if (!/^[\w.-]+$/.test(name)) return void res.status(404).end();
    const file = await storage.getFile(name);
    if (!file) return void res.status(404).end();
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (name.endsWith('.har')) res.setHeader('Content-Disposition', 'attachment');
    res.end(file.buffer);
  } catch (e) {
    next(e);
  }
});

/** STT kế tiếp trong một dự án (lớn nhất hiện có + 1). */
const nextStt = (db: Database, projectId: string): number =>
  db.feedbacks.filter((f) => f.projectId === projectId).reduce((max, f) => Math.max(max, f.stt), 0) + 1;

/** Đổi trạng thái backlog; chuyển sang "done" thì ghi ngày hoàn thành, ngược lại xóa. */
function setStatus(item: Feedback, status: FeedbackStatus): void {
  if (item.status === status) return;
  item.status = status;
  item.completedAt = status === 'done' ? now() : null;
}

/* ---------- Upload ---------- */
/** Đuôi file tương ứng với từng loại ảnh được phép tải lên. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB mỗi ảnh
const MAX_REQUEST_BYTES = Math.floor(4.2 * 1024 * 1024); // Vercel giới hạn body 4.5MB mỗi request
const MAX_HAR_SIZE = 50 * 1024 * 1024; // 50MB mỗi file HAR
/** Tên field form chứa file HAR. */
const HAR_FIELD = 'har_file';

/** File có phải HAR hợp lệ không: đúng field và (đuôi .har hoặc MIME JSON/octet-stream). */
const isHarUpload = (file: Express.Multer.File): boolean =>
  file.fieldname === HAR_FIELD &&
  (/\.har$/i.test(file.originalname) || ['application/json', 'application/octet-stream'].includes(file.mimetype));

const upload = multer({
  storage: multer.memoryStorage(), // file chỉ thực sự được lưu khi request thành công (cùng transaction với dữ liệu)
  limits: { fileSize: MAX_HAR_SIZE, files: 31 },
  fileFilter: (req, file, cb) => cb(null, file.fieldname === HAR_FIELD ? isHarUpload(file) : Boolean(EXT_BY_MIME[file.mimetype])),
});

const multerFields = upload.fields([
  { name: 'location_image', maxCount: 1 },
  { name: 'bug_images', maxCount: 10 },
  { name: 'expected_images', maxCount: 10 },
  { name: HAR_FIELD, maxCount: 1 },
]);

/**
 * Middleware nhận upload: chạy multer, kiểm tra lại giới hạn riêng của ảnh (multer chỉ đặt theo HAR 50MB),
 * nén ảnh sang WebP rồi xếp hàng lưu file.
 */
function uploadFields(req: Request, res: Response, next: NextFunction): void {
  multerFields(req, res, (err: unknown) => {
    // multer gọi lại từ luồng mạng -> chạy tiếp trong ngữ cảnh dữ liệu của request
    runInRequestStore(req, async () => {
      if (err) return next(err);
      const tooBig = allFiles(req.files).some((f) => f.fieldname !== HAR_FIELD && f.size > MAX_IMAGE_SIZE);
      if (tooBig) {
        stageUploads(req.files);
        failUpload(req, res, 400, 'Ảnh vượt quá 10MB.');
        return;
      }
      try {
        // nén ảnh sang WebP trước khi lưu
        await Promise.all(
          allFiles(req.files)
            .filter((f) => f.fieldname !== HAR_FIELD)
            .map(async (f) => {
              const out = await compressImage(f.buffer, f.mimetype);
              if (out.ext) {
                f.buffer = out.buffer;
                f.size = out.buffer.length;
                f.mimetype = out.mime;
              }
            })
        );
      } catch {
        // nén lỗi -> giữ ảnh gốc
      }
      stageUploads(req.files);
      next();
    });
  });
}

/** Đặt tên file ngẫu nhiên và xếp hàng lưu (ghi vào Postgres / thư mục uploads khi commit). */
function stageUploads(files: Request['files']): void {
  for (const f of allFiles(files)) {
    const isHar = f.fieldname === HAR_FIELD;
    f.filename = crypto.randomUUID() + (isHar ? '.har' : EXT_BY_MIME[f.mimetype] || '.png');
    queueUpload({
      name: f.filename,
      mime: isHar ? 'application/json' : f.mimetype,
      size: f.size,
      originalname: f.originalname,
      buffer: f.buffer,
    });
  }
}

/** Chuyển file HAR vừa tải lên thành thông tin lưu trong backlog; không có file -> null. */
const toHar = (files: Express.Multer.File[] | undefined): Feedback['har'] => {
  const file = (files || [])[0];
  return file ? { url: '/uploads/' + file.filename, name: file.originalname || 'network.har', size: file.size } : null;
};

/** Danh sách đường dẫn `/uploads/...` của các file vừa tải lên. */
const toUrls = (files: Express.Multer.File[] | undefined): string[] => (files || []).map((f) => '/uploads/' + f.filename);

/** Gộp mọi file của request (nhiều field) thành một mảng phẳng. */
const allFiles = (files: Request['files']): Express.Multer.File[] =>
  Array.isArray(files) ? files : Object.values((files || {}) as UploadedFiles).flat();

/** Đánh dấu xóa file theo URL `/uploads/...` (xóa thật khi request thành công). */
function removeFile(url: unknown): void {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  queueFileDelete(path.basename(url)); // xóa thật khi request thành công
}

/** Mọi file (ảnh + HAR) thuộc một backlog, dùng khi xóa backlog/dự án. */
const feedbackFiles = (f: Feedback): Array<string | null> => [f.location.image, ...f.bug.images, ...f.expected.images, f.har && f.har.url];

/** Parse chuỗi JSON thành mảng chuỗi; sai định dạng -> mảng rỗng. */
function parseList(value: unknown): string[] {
  try {
    const list: unknown = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(list) ? (list as string[]) : [];
  } catch {
    return [];
  }
}

/** Trả lỗi cho request có upload: dọn file vừa tải lên để không bị rác. */
function failUpload(req: Request, res: Response, code: number, error: string): void {
  allFiles(req.files).forEach((f) => removeFile('/uploads/' + f.filename));
  res.status(code).json({ error });
}

/** Kiểm tra và chuẩn hóa tên lỗi / loại / ghi chú của backlog. */
function feedbackMeta(body: Record<string, unknown>): ValidationError | { title: string; type: string; note: string } {
  const title = str(body.title);
  const type = str(body.type);
  const note = str(body.note_text);
  if (title.length > 200) return { error: 'Tên lỗi tối đa 200 ký tự.' };
  if (type.length > 60) return { error: 'Loại tối đa 60 ký tự.' };
  return { title, type, note };
}

/* ---------- API: Dự án ---------- */

/**
 * Kiểm tra dữ liệu dự án gửi lên (tên, mã, mô tả).
 * @param selfId id dự án đang sửa, để bỏ qua chính nó khi kiểm tra trùng
 */
function validateProject(
  db: Database,
  body: Record<string, unknown>,
  selfId?: string
): ValidationError | { name: string; code: string; description: string } {
  const name = str(body.name);
  if (!name) return { error: 'Vui lòng nhập tên dự án.' };
  if (name.length > 120) return { error: 'Tên dự án tối đa 120 ký tự.' };
  if (db.projects.some((p) => p.id !== selfId && sameName(p.name, name))) {
    return { error: `Dự án "${name}" đã tồn tại.` };
  }
  // Mã dự án (không bắt buộc, không trùng, lưu dạng chữ hoa)
  const code = str(body.code).toUpperCase();
  if (code.length > 30) return { error: 'Mã dự án tối đa 30 ký tự.' };
  if (code && db.projects.some((p) => p.id !== selfId && p.code === code)) {
    return { error: `Mã dự án "${code}" đã được dùng.` };
  }
  return { name, code, description: str(body.description) };
}

app.get('/api/projects', (req, res) => {
  res.json(readDb().projects);
});

app.post('/api/projects', (req, res) => {
  const db = readDb();
  const result = validateProject(db, req.body || {});
  if ('error' in result) return void res.status(400).json(result);

  const project = newProject(result.name, result.description, result.code);
  db.projects.push(project);
  writeDb(db);
  res.status(201).json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const db = readDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return void res.status(404).json({ error: 'Không tìm thấy dự án.' });

  const result = validateProject(db, req.body || {}, project.id);
  if ('error' in result) return void res.status(400).json(result);

  project.name = result.name;
  project.code = result.code;
  project.description = result.description;
  project.updatedAt = now();
  writeDb(db);
  res.json(project);
});

// Xóa dự án kèm toàn bộ backlog (và ảnh) của dự án đó.
app.delete('/api/projects/:id', (req, res) => {
  const db = readDb();
  const index = db.projects.findIndex((p) => p.id === req.params.id);
  if (index === -1) return void res.status(404).json({ error: 'Không tìm thấy dự án.' });

  const [project] = db.projects.splice(index, 1) as [Project];
  const removed = db.feedbacks.filter((f) => f.projectId === project.id);
  db.feedbacks = db.feedbacks.filter((f) => f.projectId !== project.id);
  writeDb(db);
  removed.flatMap(feedbackFiles).forEach(removeFile);
  res.json({ ok: true, removedFeedbacks: removed.length });
});

/* ---------- API: Team xử lý ---------- */

/** Kiểm tra dữ liệu team gửi lên (tên không trùng, trưởng nhóm, mô tả). */
function validateTeam(
  db: Database,
  body: Record<string, unknown>,
  selfId?: string
): ValidationError | { name: string; lead: string; description: string } {
  const name = str(body.name);
  if (!name) return { error: 'Vui lòng nhập tên team.' };
  if (name.length > 120) return { error: 'Tên team tối đa 120 ký tự.' };
  if (db.teams.some((t) => t.id !== selfId && sameName(t.name, name))) {
    return { error: `Team "${name}" đã tồn tại.` };
  }
  const lead = str(body.lead);
  if (lead.length > 120) return { error: 'Tên trưởng nhóm tối đa 120 ký tự.' };
  return { name, lead, description: str(body.description) };
}

app.get('/api/teams', (req, res) => {
  res.json(readDb().teams);
});

app.post('/api/teams', (req, res) => {
  const db = readDb();
  const result = validateTeam(db, req.body || {});
  if ('error' in result) return void res.status(400).json(result);

  const team = newTeam(result.name, result.lead, result.description);
  db.teams.push(team);
  writeDb(db);
  res.status(201).json(team);
});

app.put('/api/teams/:id', (req, res) => {
  const db = readDb();
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return void res.status(404).json({ error: 'Không tìm thấy team.' });

  const result = validateTeam(db, req.body || {}, team.id);
  if ('error' in result) return void res.status(400).json(result);

  Object.assign(team, result, { updatedAt: now() });
  writeDb(db);
  res.json(team);
});

// Xóa team: các backlog đang giao cho team này trở về "chưa phân công".
app.delete('/api/teams/:id', (req, res) => {
  const db = readDb();
  const index = db.teams.findIndex((t) => t.id === req.params.id);
  if (index === -1) return void res.status(404).json({ error: 'Không tìm thấy team.' });

  const [team] = db.teams.splice(index, 1) as [Team];
  let unassigned = 0;
  for (const f of db.feedbacks) {
    if (f.teamId === team.id) {
      f.teamId = '';
      unassigned++;
    }
  }
  writeDb(db);
  res.json({ ok: true, unassigned });
});

/* ---------- API: Backlog (feedback) ---------- */
app.get('/api/feedbacks', (req, res) => {
  res.json(readDb().feedbacks);
});

/** Tạo backlog mới (multipart: các field văn bản + ảnh vị trí / mô tả / kết quả mong muốn + file HAR). */
app.post('/api/feedbacks', uploadFields, (req, res) => {
  const files = (req.files || {}) as UploadedFiles;
  const db = readDb();

  const projectId = str(req.body.project_id);
  if (!db.projects.some((p) => p.id === projectId)) return failUpload(req, res, 400, 'Vui lòng chọn dự án.');

  const status = str(req.body.status) || 'todo';
  if (!isStatus(status)) return failUpload(req, res, 400, 'Trạng thái không hợp lệ.');

  const teamId = str(req.body.team_id);
  if (teamId && !db.teams.some((t) => t.id === teamId)) return failUpload(req, res, 400, 'Team không tồn tại.');

  const meta = feedbackMeta(req.body);
  if ('error' in meta) return failUpload(req, res, 400, meta.error);

  const item: Feedback = {
    id: crypto.randomUUID(),
    projectId,
    teamId,
    title: meta.title,
    type: meta.type,
    note: meta.note,
    stt: nextStt(db, projectId),
    status,
    location: {
      url: str(req.body.location_url),
      image: toUrls(files.location_image)[0] || '',
    },
    bug: { text: str(req.body.bug_text), images: toUrls(files.bug_images) },
    expected: { text: str(req.body.expected_text), images: toUrls(files.expected_images) },
    har: toHar(files[HAR_FIELD]),
    completedAt: status === 'done' ? now() : null,
    createdAt: now(),
    updatedAt: now(),
  };

  db.feedbacks.push(item);
  writeDb(db);
  res.status(201).json(item);
});

/** Cập nhật backlog: đổi dự án/team/trạng thái, thêm hoặc xóa ảnh và HAR. */
app.put('/api/feedbacks/:id', uploadFields, (req, res) => {
  const files = (req.files || {}) as UploadedFiles;
  const db = readDb();
  const item = db.feedbacks.find((f) => f.id === req.params.id);
  if (!item) return failUpload(req, res, 404, 'Không tìm thấy backlog.');

  const projectId = str(req.body.project_id);
  if (!db.projects.some((p) => p.id === projectId)) return failUpload(req, res, 400, 'Vui lòng chọn dự án.');

  const status = str(req.body.status) || item.status;
  if (!isStatus(status)) return failUpload(req, res, 400, 'Trạng thái không hợp lệ.');

  const teamId = str(req.body.team_id);
  if (teamId && !db.teams.some((t) => t.id === teamId)) return failUpload(req, res, 400, 'Team không tồn tại.');
  item.teamId = teamId;

  // Đổi dự án -> cấp lại STT trong dự án mới
  if (projectId !== item.projectId) {
    item.stt = nextStt(db, projectId);
    item.projectId = projectId;
  }
  setStatus(item, status);

  // Vị trí
  item.location.url = str(req.body.location_url);
  const newLocation = toUrls(files.location_image)[0];
  if (newLocation || req.body.remove_location_image === '1') {
    removeFile(item.location.image);
    item.location.image = newLocation || '';
  }

  // Tên lỗi, loại, ghi chú
  const meta = feedbackMeta(req.body);
  if ('error' in meta) return failUpload(req, res, 400, meta.error);
  Object.assign(item, meta);

  // Mô tả lỗi
  item.bug.text = str(req.body.bug_text);
  const removeBug = parseList(req.body.remove_bug_images).filter((u) => item.bug.images.includes(u));
  removeBug.forEach(removeFile);
  item.bug.images = item.bug.images.filter((u) => !removeBug.includes(u)).concat(toUrls(files.bug_images));

  // Kết quả mong muốn
  item.expected.text = str(req.body.expected_text);
  const removeExpected = parseList(req.body.remove_expected_images).filter((u) => item.expected.images.includes(u));
  removeExpected.forEach(removeFile);
  item.expected.images = item.expected.images.filter((u) => !removeExpected.includes(u)).concat(toUrls(files.expected_images));

  // File HAR (network log)
  const newHar = toHar(files[HAR_FIELD]);
  if (newHar || req.body.remove_har === '1') {
    if (item.har) removeFile(item.har.url);
    item.har = newHar;
  }

  item.updatedAt = now();
  writeDb(db);
  res.json(item);
});

// Đổi nhanh trạng thái (chưa làm / đang làm / đã hoàn thành)
app.patch('/api/feedbacks/:id/status', (req, res) => {
  const db = readDb();
  const item = db.feedbacks.find((f) => f.id === req.params.id);
  if (!item) return void res.status(404).json({ error: 'Không tìm thấy backlog.' });

  const status = str((req.body || {}).status);
  if (!isStatus(status)) return void res.status(400).json({ error: 'Trạng thái không hợp lệ.' });

  setStatus(item, status);
  item.updatedAt = now();
  writeDb(db);
  res.json(item);
});

// Giao nhanh cho team (dùng cho MCP / tích hợp ngoài)
app.patch('/api/feedbacks/:id/team', (req, res) => {
  const db = readDb();
  const item = db.feedbacks.find((f) => f.id === req.params.id);
  if (!item) return void res.status(404).json({ error: 'Không tìm thấy backlog.' });

  const teamId = str((req.body || {}).team_id);
  if (teamId && !db.teams.some((t) => t.id === teamId)) return void res.status(400).json({ error: 'Team không tồn tại.' });

  item.teamId = teamId;
  item.updatedAt = now();
  writeDb(db);
  res.json(item);
});

app.delete('/api/feedbacks/:id', (req, res) => {
  const db = readDb();
  const index = db.feedbacks.findIndex((f) => f.id === req.params.id);
  if (index === -1) return void res.status(404).json({ error: 'Không tìm thấy backlog.' });

  const [item] = db.feedbacks.splice(index, 1) as [Feedback];
  writeDb(db);
  feedbackFiles(item).forEach(removeFile);
  res.json({ ok: true });
});

/* ---------- Xuất Excel ---------- */
/** Nhãn tiếng Việt của trạng thái, dùng trong file Excel. */
const STATUS_LABELS: Record<string, string> = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Đã hoàn thành' };

// Áp dụng cùng bộ lọc như giao diện: project, status, q
app.get('/api/export', async (req, res, next) => {
  try {
    const db = readDb();
    const projectName = (id: string): string => db.projects.find((p) => p.id === id)?.name || '';
    const projectCode = (id: string): string => db.projects.find((p) => p.id === id)?.code || '';
    const teamName = (id: string): string => db.teams.find((t) => t.id === id)?.name || '';
    const projectId = str(req.query.project);
    const teamFilter = str(req.query.team);
    const typeFilter = str(req.query.type);
    const status = str(req.query.status);
    const q = str(req.query.q).toLowerCase();
    const base = req.protocol + '://' + req.get('host');
    const abs = (u: string): string => (u ? base + u : '');

    const list = db.feedbacks
      .filter((f) => !projectId || f.projectId === projectId)
      .filter((f) => !status || f.status === status)
      .filter((f) => !teamFilter || (teamFilter === 'none' ? !f.teamId : f.teamId === teamFilter))
      .filter((f) => !typeFilter || (typeFilter === 'none' ? !f.type : sameName(f.type, typeFilter)))
      .filter(
        (f) =>
          !q ||
          [projectCode(f.projectId), projectName(f.projectId), f.type, f.title, f.location.url, f.bug.text, f.expected.text, f.note].some(
            (s) =>
              String(s || '')
                .toLowerCase()
                .includes(q)
          )
      )
      .sort((a, b) => projectName(a.projectId).localeCompare(projectName(b.projectId), 'vi') || a.stt - b.stt);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Backlog', { views: [{ state: 'frozen', ySplit: 1 }] });
    // Thứ tự cột theo cách ghi backlog: mã dự án - tên dự án - loại - team - tên lỗi - vị trí lỗi - mô tả - kết quả mong muốn - ghi chú
    ws.columns = [
      { header: 'Mã dự án', key: 'code', width: 12 },
      { header: 'Tên dự án', key: 'project', width: 22 },
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Loại', key: 'type', width: 18 },
      { header: 'Team xử lý', key: 'team', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 16 },
      { header: 'Tên lỗi', key: 'title', width: 34 },
      { header: 'Vị trí lỗi (URL)', key: 'url', width: 36 },
      { header: 'Ảnh vị trí lỗi', key: 'locImg', width: 30 },
      { header: 'Mô tả lỗi', key: 'bug', width: 50 },
      { header: 'Ảnh mô tả lỗi', key: 'bugImgs', width: 30 },
      { header: 'Kết quả mong muốn', key: 'expected', width: 50 },
      { header: 'Ảnh kết quả mong muốn', key: 'expImgs', width: 30 },
      { header: 'Ghi chú', key: 'note', width: 36 },
      { header: 'File HAR', key: 'har', width: 30 },
      { header: 'Ngày tạo', key: 'createdAt', width: 18 },
      { header: 'Ngày hoàn thành', key: 'completedAt', width: 18 },
    ];
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

    const date = (v: string | null): Date | null => (v ? new Date(v) : null);
    for (const f of list) {
      ws.addRow({
        code: projectCode(f.projectId),
        project: projectName(f.projectId),
        stt: f.stt,
        type: f.type,
        team: teamName(f.teamId),
        status: STATUS_LABELS[f.status] || f.status,
        title: f.title,
        url: f.location.url,
        locImg: abs(f.location.image),
        bug: f.bug.text,
        bugImgs: f.bug.images.map(abs).join('\n'),
        expected: f.expected.text,
        expImgs: f.expected.images.map(abs).join('\n'),
        note: f.note,
        har: f.har ? abs(f.har.url) : '',
        createdAt: date(f.createdAt),
        completedAt: date(f.completedAt),
      });
    }
    ws.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });
    ws.getColumn('createdAt').numFmt = 'dd/mm/yyyy hh:mm';
    ws.getColumn('completedAt').numFmt = 'dd/mm/yyyy hh:mm';
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

    const file = 'backlog-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    next(e);
  }
});

/* ---------- Bảo mật: giới hạn tốc độ ---------- */

/**
 * Tạo bộ giới hạn tốc độ in-memory, cửa sổ cố định.
 * @param max số lần tối đa trong một cửa sổ
 * @param windowMs độ dài cửa sổ (ms)
 */
function makeLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, { count: number; reset: number }>();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs);
  timer.unref();
  return {
    // ghi nhận 1 lần; trả về số giây phải chờ nếu vượt giới hạn, ngược lại 0
    hit(key) {
      const t = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= t) hits.set(key, (v = { count: 0, reset: t + windowMs }));
      v.count++;
      return v.count > max ? Math.ceil((v.reset - t) / 1000) : 0;
    },
    // chỉ kiểm tra (không ghi nhận)
    over(key) {
      const v = hits.get(key);
      return v && v.reset > Date.now() && v.count > max ? Math.ceil((v.reset - Date.now()) / 1000) : 0;
    },
  };
}

// DEV_NO_AUTH=1: bỏ xác thực (quản trị người dùng + MCP) — CHỈ dùng khi chạy local để thử.
const DEV_NO_AUTH = process.env.DEV_NO_AUTH === '1';
if (DEV_NO_AUTH) console.warn('[BẢO MẬT] DEV_NO_AUTH=1: quản lý người dùng và /mcp KHÔNG có xác thực — chỉ dùng khi chạy local!');

/* ---------- Quản lý người dùng + token cá nhân ---------- */
// Mỗi người dùng có 1 token riêng. Vai trò: read (chỉ đọc), write (đọc + ghi), admin (ghi + quản lý người dùng).
// Không có khóa dùng chung: quản trị viên đầu tiên tạo bằng `npm run create-admin` trên server.
const ROLES: Role[] = ['read', 'write', 'admin'];
/** Type guard: chuỗi có phải quyền hợp lệ không. */
const isRole = (v: string): v is Role => (ROLES as string[]).includes(v);

/** Admin còn dùng được = đang hoạt động và có token cá nhân hoặc mật khẩu đăng nhập. */
const isActiveAdmin = (u: User): boolean => u.role === 'admin' && u.active && (Boolean(u.tokenHash) || Boolean(u.passwordHash));

/** Lấy token từ header `Authorization: Bearer <token>`; không có -> ''. */
const bearer = (req: Request): string => {
  const m = /^Bearer (.{1,256})$/i.exec(req.get('authorization') || '');
  return m ? (m[1] as string) : '';
};

/** Cấp token mới cho người dùng (ghi đè token cũ). Token gốc chỉ trả về đúng một lần, DB chỉ lưu băm. */
function issueToken(user: User): string {
  const token = newToken();
  user.tokenHash = hashToken(token);
  user.tokenHint = tokenHint(token);
  user.tokenCreatedAt = now();
  user.lastUsedAt = null;
  return token; // chỉ trả về đúng 1 lần, DB chỉ lưu băm
}

/** Loại bỏ các giá trị băm nhạy cảm trước khi gửi người dùng ra giao diện. */
const publicUser = (u: User): PublicUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  teamId: u.teamId || '',
  active: u.active,
  hasToken: Boolean(u.tokenHash),
  hasPassword: Boolean(u.passwordHash),
  tokenHint: u.tokenHash ? u.tokenHint : '',
  tokenCreatedAt: u.tokenCreatedAt || null,
  lastUsedAt: u.lastUsedAt || null,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

/** Tìm người dùng theo token cá nhân (so sánh băm, thời gian cố định). */
function findUserByToken(db: Database, token: string): User | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const hash = Buffer.from(hashToken(token), 'hex');
  let found: User | null = null;
  for (const u of db.users) {
    // duyệt hết, không dừng sớm, để thời gian xử lý không phụ thuộc vị trí khớp
    if (u.tokenHash && crypto.timingSafeEqual(Buffer.from(u.tokenHash, 'hex'), hash)) found = u;
  }
  return found;
}

/** Ghi nhật ký hoạt động quản trị (giữ 500 dòng gần nhất). */
function audit(db: Database, actor: string, action: string, target: string): void {
  db.audit.push({ at: now(), actor, action, target });
  if (db.audit.length > 500) db.audit.splice(0, db.audit.length - 500);
}

const adminPerIp = makeLimiter(120, 60 * 1000); // 120 request quản trị / phút / IP
const adminBadAuth = makeLimiter(8, 15 * 60 * 1000); // sai token quản trị > 8 lần / 15 phút -> khóa IP

/* Phiên đăng nhập quản trị bằng email + mật khẩu: hết hạn sau 8 giờ, lưu trong DB (db.sessions) để mọi instance đều nhận ra */
const SESSION_PREFIX = 'fbs_';
const SESSION_TTL = 8 * 60 * 60 * 1000;

/** Tên cookie lưu phiên quản trị (HttpOnly) để server render được trang Người dùng. */
const ADMIN_COOKIE = 'fb_admin';

/** Đọc một cookie từ header `Cookie`; không có -> ''. */
function getCookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** Đặt (hoặc xóa khi `token` rỗng) cookie phiên quản trị: HttpOnly + SameSite=Strict (chống CSRF). */
function setAdminCookie(req: Request, res: Response, token: string): void {
  const maxAge = token ? Math.floor(SESSION_TTL / 1000) : 0;
  res.append(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`
  );
}

/** Tạo phiên đăng nhập mới cho người dùng và dọn các phiên đã hết hạn. Trả về token phiên (chỉ lưu băm). */
function createSession(db: Database, userId: string): string {
  const t = Date.now();
  for (const [k, v] of Object.entries(db.sessions)) if (v.exp <= t) delete db.sessions[k]; // dọn phiên hết hạn
  const token = SESSION_PREFIX + crypto.randomBytes(32).toString('base64url');
  db.sessions[hashToken(token)] = { userId, exp: t + SESSION_TTL };
  return token;
}

/** Tìm người dùng theo token phiên; hết hạn hoặc không tồn tại -> null. */
function findSessionUser(db: Database, token: string): User | null {
  if (!token || !token.startsWith(SESSION_PREFIX)) return null;
  const s = db.sessions[hashToken(token)];
  if (!s || s.exp <= Date.now()) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}

// Băm giả để mọi lần đăng nhập đều tốn thời gian như nhau (không lộ email nào tồn tại)
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/**
 * Middleware bảo vệ các API quản trị: giới hạn tốc độ, khóa IP khi sai nhiều lần,
 * rồi xác thực bằng token phiên (đăng nhập mật khẩu) hoặc token cá nhân của admin.
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || 'unknown';
  // Đang bị khóa vì sai nhiều lần -> chặn luôn, không so sánh token nữa
  const locked = adminBadAuth.over(ip);
  if (locked) {
    res.setHeader('Retry-After', String(locked));
    res.status(429).json({ code: 'admin-locked', error: `Sai token quản trị quá nhiều lần, thử lại sau ${locked}s.` });
    return;
  }
  const wait = adminPerIp.hit(ip);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ error: `Quá nhiều yêu cầu, thử lại sau ${wait}s.` });
    return;
  }
  if (DEV_NO_AUTH) {
    req.admin = { id: '', name: 'local' };
    next();
    return;
  }

  const db = readDb();
  if (!db.users.some(isActiveAdmin)) {
    res.status(503).json({
      code: 'admin-setup',
      error:
        'Chưa có quản trị viên nào. Đặt ADMIN_EMAIL + ADMIN_PASSWORD trong .env rồi khởi động lại, hoặc chạy: npm run create-admin -- "Họ tên" email@congty.vn',
    });
    return;
  }
  const credential = bearer(req) || getCookie(req, ADMIN_COOKIE);
  const user = findSessionUser(db, credential) || findUserByToken(db, credential);
  if (!user) {
    adminBadAuth.hit(ip);
    res.status(401).json({ code: 'admin-auth', error: 'Thiếu hoặc sai token quản trị.' });
    return;
  }
  if (!user.active || user.role !== 'admin') {
    res.status(403).json({ code: 'admin-forbidden', error: 'Tài khoản này không có quyền quản trị.' });
    return;
  }
  req.admin = user;
  touchLastUsed(user.id).then(
    () => next(),
    () => next()
  );
}

/** Tên quản trị viên đang thao tác (ghi vào nhật ký); luôn có sau `requireAdmin`. */
const adminName = (req: Request): string => req.admin?.name ?? 'admin';

/** Biểu thức kiểm tra email đơn giản: có phần tên, @, tên miền và đuôi. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Đăng nhập quản trị bằng email + mật khẩu -> trả về token phiên (dùng như Bearer cho /api/users)
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const locked = adminBadAuth.over(ip);
  if (locked) {
    res.setHeader('Retry-After', String(locked));
    return void res.status(429).json({ code: 'admin-locked', error: `Sai thông tin đăng nhập quá nhiều lần, thử lại sau ${locked}s.` });
  }
  const wait = adminPerIp.hit(ip);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return void res.status(429).json({ error: `Quá nhiều yêu cầu, thử lại sau ${wait}s.` });
  }

  const body = req.body || {};
  const db = readDb();
  // Hai cách đăng nhập: token cá nhân ({ token }) hoặc email + mật khẩu ({ email, password })
  const personalToken = typeof body.token === 'string' ? body.token.trim().slice(0, 256) : '';
  let user: User | undefined;
  let ok: boolean;
  if (personalToken) {
    user = findUserByToken(db, personalToken) ?? undefined;
    ok = Boolean(user);
  } else {
    const email = str(body.email).toLowerCase().slice(0, 200);
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    user = db.users.find((u) => u.email === email && u.passwordHash);
    // luôn băm mật khẩu (kể cả khi email không tồn tại) để thời gian xử lý không lộ thông tin
    ok = verifyPassword(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH) && Boolean(user);
  }
  if (!ok || !user) {
    adminBadAuth.hit(ip);
    return void res
      .status(401)
      .json({ code: 'admin-auth', error: personalToken ? 'Token không đúng.' : 'Email hoặc mật khẩu không đúng.' });
  }
  if (!user.active || user.role !== 'admin') {
    return void res.status(403).json({ code: 'admin-forbidden', error: 'Tài khoản này không có quyền quản trị.' });
  }
  const token = createSession(db, user.id);
  audit(db, user.name, 'đăng nhập quản trị', user.name);
  writeDb(db);
  setAdminCookie(req, res, token); // trình duyệt dùng cookie; token vẫn trả về cho client API khác
  res.json({ token, name: user.name });
});

// Đăng xuất: hủy phiên trên server
app.delete('/api/admin/session', (req, res) => {
  const token = bearer(req) || getCookie(req, ADMIN_COOKIE);
  const db = readDb();
  if (token.startsWith(SESSION_PREFIX) && db.sessions[hashToken(token)]) {
    delete db.sessions[hashToken(token)];
    writeDb(db);
  }
  setAdminCookie(req, res, '');
  res.json({ ok: true });
});

// Admin cứng: ADMIN_EMAIL + ADMIN_PASSWORD trong .env -> mỗi lần khởi động đảm bảo tài khoản này tồn tại,
// là admin, đang hoạt động và có đúng mật khẩu đó (mật khẩu chỉ lưu dạng băm trong db.json).
function seedAdmin(): void {
  const email = str(process.env.ADMIN_EMAIL).toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return;
  if (!EMAIL_RE.test(email) || password.length < 8) {
    console.warn('[Admin] ADMIN_EMAIL không hợp lệ hoặc ADMIN_PASSWORD ngắn hơn 8 ký tự -> bỏ qua admin cứng.');
    return;
  }
  const db = readDb();
  let user: User | undefined = db.users.find((u) => u.email === email);
  let changed = false;
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      name: str(process.env.ADMIN_NAME) || email.split('@')[0],
      email,
      role: 'admin',
      teamId: '',
      active: true,
      tokenHash: '',
      tokenHint: '',
      createdAt: now(),
      updatedAt: now(),
    };
    db.users.push(user);
    changed = true;
  }
  if (user.role !== 'admin' || !user.active) {
    Object.assign(user, { role: 'admin', active: true, updatedAt: now() });
    changed = true;
  }
  if (!verifyPassword(password, user.passwordHash)) {
    user.passwordHash = hashPassword(password);
    user.updatedAt = now();
    changed = true;
  }
  if (changed) {
    audit(db, 'hệ thống', 'đảm bảo admin cứng từ .env', user.name);
    writeDb(db);
    console.log(`[Admin] Đã đảm bảo admin: ${user.name} <${user.email}>`);
  }
}

/** Kiểm tra dữ liệu người dùng gửi lên (tên, email không trùng, quyền, team, trạng thái hoạt động). */
function validateUser(
  db: Database,
  body: Record<string, unknown>,
  selfId?: string
): ValidationError | { name: string; email: string; role: Role; teamId: string; active: boolean } {
  const name = str(body.name);
  if (!name) return { error: 'Vui lòng nhập tên người dùng.' };
  if (name.length > 120) return { error: 'Tên tối đa 120 ký tự.' };

  const email = str(body.email).toLowerCase();
  if (!email) return { error: 'Vui lòng nhập email.' };
  if (email.length > 200 || !EMAIL_RE.test(email)) return { error: 'Email không hợp lệ.' };
  if (db.users.some((u) => u.id !== selfId && u.email === email)) return { error: `Email "${email}" đã được dùng.` };

  const role = str(body.role) || 'read';
  if (!isRole(role)) return { error: 'Quyền không hợp lệ.' };

  const teamId = str(body.teamId);
  if (teamId && !db.teams.some((t) => t.id === teamId)) return { error: 'Team không tồn tại.' };

  return { name, email, role, teamId, active: body.active === undefined ? true : body.active === true };
}

// Không cho làm mất quản trị viên cuối cùng (sẽ tự khóa mình ra ngoài)
const LAST_ADMIN_ERROR = 'Đây là quản trị viên hoạt động cuối cùng — không thể hạ quyền, vô hiệu hóa, thu hồi token hoặc xóa.';
/** `true` nếu `user` là quản trị viên hoạt động duy nhất còn lại. */
const isLastAdmin = (db: Database, user: User): boolean =>
  isActiveAdmin(user) && !db.users.some((u) => u.id !== user.id && isActiveAdmin(u));

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(readDb().users.map(publicUser));
});

app.get('/api/users/audit', requireAdmin, (req, res) => {
  res.json(readDb().audit.slice(-50).reverse());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const db = readDb();
  const result = validateUser(db, req.body || {});
  if ('error' in result) return void res.status(400).json(result);

  const user: User = { tokenHash: '', tokenHint: '', id: crypto.randomUUID(), ...result, createdAt: now(), updatedAt: now() };
  const token = issueToken(user);
  db.users.push(user);
  audit(db, adminName(req), `tạo người dùng (${user.role})`, user.name);
  writeDb(db);
  res.status(201).json({ user: publicUser(user), token });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return void res.status(404).json({ error: 'Không tìm thấy người dùng.' });

  const result = validateUser(db, { active: user.active, ...(req.body || {}) }, user.id);
  if ('error' in result) return void res.status(400).json(result);
  if (isLastAdmin(db, user) && (result.role !== 'admin' || !result.active)) {
    return void res.status(400).json({ error: LAST_ADMIN_ERROR });
  }

  const changes = [];
  if (result.role !== user.role) changes.push(`quyền ${user.role} → ${result.role}`);
  if (result.active !== user.active) changes.push(result.active ? 'kích hoạt' : 'vô hiệu hóa');
  Object.assign(user, result, { updatedAt: now() });
  audit(db, adminName(req), `sửa người dùng${changes.length ? ' (' + changes.join(', ') + ')' : ''}`, user.name);
  writeDb(db);
  res.json(publicUser(user));
});

// Cấp lại token (token cũ mất hiệu lực ngay)
app.post('/api/users/:id/token', requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return void res.status(404).json({ error: 'Không tìm thấy người dùng.' });

  const token = issueToken(user);
  user.updatedAt = now();
  audit(db, adminName(req), 'cấp lại token', user.name);
  writeDb(db);
  res.json({ user: publicUser(user), token });
});

// Thu hồi token (user giữ lại, nhưng không kết nối được nữa)
app.delete('/api/users/:id/token', requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return void res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (isLastAdmin(db, user)) return void res.status(400).json({ error: LAST_ADMIN_ERROR });

  user.tokenHash = '';
  user.tokenHint = '';
  user.tokenCreatedAt = null;
  user.updatedAt = now();
  audit(db, adminName(req), 'thu hồi token', user.name);
  writeDb(db);
  res.json(publicUser(user));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const db = readDb();
  const index = db.users.findIndex((u) => u.id === req.params.id);
  const target = db.users[index];
  if (!target) return void res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (isLastAdmin(db, target)) return void res.status(400).json({ error: LAST_ADMIN_ERROR });

  const [user] = db.users.splice(index, 1) as [User];
  audit(db, adminName(req), 'xóa người dùng', user.name);
  writeDb(db);
  res.json({ ok: true });
});

/* ---------- MCP (Streamable HTTP) ---------- */
// Dev kết nối: claude mcp add --transport http feedback-backlog https://<host>/mcp --header "Authorization: Bearer <token cá nhân>"
//
// Bảo mật (mặc định ĐÓNG):
//  - Mỗi người dùng có 1 token riêng (tạo ở trang "Người dùng", do quản trị viên cấp); không có token hợp lệ -> 401.
//  - Quyền theo từng user: chỉ đọc / đọc + ghi. Tài khoản bị vô hiệu hóa hoặc thu hồi token -> không vào được.
//  - Giới hạn tốc độ theo IP + toàn server, khóa IP tạm thời khi sai token nhiều lần, giới hạn request đồng thời.
//  - MCP_READONLY=1: ép toàn server chỉ đọc.  PUBLIC_URL: địa chỉ công khai để dựng link ảnh / HAR.
const MCP_READONLY = process.env.MCP_READONLY === '1';

const mcpPerIp = makeLimiter(60, 60 * 1000); // 60 request / phút / IP
const mcpGlobal = makeLimiter(300, 60 * 1000); // 300 request / phút toàn server
const mcpBadAuth = makeLimiter(8, 15 * 60 * 1000); // sai token > 8 lần / 15 phút -> khóa IP 15 phút
const MCP_MAX_CONCURRENT = 8;
const MCP_REQUEST_TIMEOUT = 60 * 1000;
let mcpActive = 0;

const lastUsedWrites = new Map<string, number>(); // userId -> thời điểm ghi lastUsedAt gần nhất (ghi tối đa 1 lần / phút / instance)

/** Cập nhật `lastUsedAt` của người dùng (giới hạn 1 lần/phút/instance để không ghi DB quá nhiều). */
async function touchLastUsed(userId: string): Promise<void> {
  const t = Date.now();
  if (t - (lastUsedWrites.get(userId) || 0) < 60 * 1000) return;
  lastUsedWrites.set(userId, t);
  const update = (): void => {
    const db = readDb();
    const user = db.users.find((u) => u.id === userId);
    if (user) {
      user.lastUsedAt = now();
      writeDb(db);
    }
  };
  // Đang trong request ghi (đã giữ khóa) thì ghi thẳng, mở transaction thứ hai sẽ tự khóa chết
  if (isLocked()) update();
  else await storage.withStore(true, update);
}

// Nguồn dữ liệu cho MCP: đọc / ghi thẳng trong tiến trình (ghi mở transaction riêng, có khóa)
const directBackend = (actor: string): Backend => ({
  async loadAll() {
    const db = readDb();
    return { projects: db.projects, teams: db.teams, feedbacks: db.feedbacks };
  },
  async fetchFile(url, maxBytes) {
    const file = await storage.getFile(path.basename(String(url)));
    if (!file) throw new Error('Không tìm thấy file.');
    if (file.buffer.length > maxBytes) throw new Error(`file quá lớn (> ${Math.round(maxBytes / 1048576)}MB)`);
    return file;
  },
  setStatus: (id, status) =>
    storage.withStore(true, () => {
      const db = readDb();
      const item = db.feedbacks.find((f) => f.id === id);
      if (!item) throw new Error('Không tìm thấy backlog.');
      setStatus(item, status);
      item.updatedAt = now();
      if (actor) item.updatedBy = actor;
      writeDb(db);
      return item;
    }),
  assignTeam: (id, teamId) =>
    storage.withStore(true, () => {
      const db = readDb();
      const item = db.feedbacks.find((f) => f.id === id);
      if (!item) throw new Error('Không tìm thấy backlog.');
      if (teamId && !db.teams.some((t) => t.id === teamId)) throw new Error('Team không tồn tại.');
      item.teamId = teamId;
      item.updatedAt = now();
      if (actor) item.updatedBy = actor;
      writeDb(db);
      return item;
    }),
});

/** Trả lỗi theo chuẩn JSON-RPC cho client MCP. */
const rpcError = (res: Response, code: number, message: string): Response =>
  res.status(code).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/** Trả 429 kèm header Retry-After. */
const tooMany = (res: Response, seconds: number): Response => {
  res.setHeader('Retry-After', String(seconds));
  return rpcError(res, 429, `Quá nhiều yêu cầu, thử lại sau ${seconds}s.`);
};

/** Thông tin cấu hình MCP / xác thực / giới hạn upload. */
const mcpInfo = (): McpInfo => ({
  enabled: true,
  authRequired: !DEV_NO_AUTH,
  readonly: MCP_READONLY,
  maxUploadBytes: storage.mode === 'pg' ? MAX_REQUEST_BYTES : 0,
});

// Thông tin cho trang hướng dẫn MCP và form backlog (giới hạn upload)
app.get('/api/mcp-info', (req, res) => {
  // maxUploadBytes: trên Vercel mỗi request tối đa ~4.5MB (0 = không giới hạn, chạy local)
  res.json(mcpInfo());
});

app.post('/mcp', async (req, res) => {
  const ip = req.ip || 'unknown';
  // Đang bị khóa vì sai token -> chặn luôn, không so sánh token nữa
  const locked = mcpBadAuth.over(ip);
  if (locked) return void tooMany(res, locked);

  const wait = mcpPerIp.hit(ip) || mcpGlobal.hit('all');
  if (wait) return void tooMany(res, wait);

  let actor = 'local';
  let canWrite = true;
  if (!DEV_NO_AUTH) {
    const user = findUserByToken(readDb(), bearer(req));
    if (!user) {
      mcpBadAuth.hit(ip);
      res.setHeader('WWW-Authenticate', 'Bearer');
      return void rpcError(res, 401, 'Thiếu hoặc sai token (header Authorization: Bearer <token cá nhân>).');
    }
    if (!user.active) return void rpcError(res, 403, 'Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên.');
    actor = user.name;
    canWrite = user.role === 'write' || user.role === 'admin';
    await touchLastUsed(user.id);
  }
  if (MCP_READONLY) canWrite = false;

  if (mcpActive >= MCP_MAX_CONCURRENT) return void tooMany(res, 5);
  mcpActive++;
  let released = false;
  const release = () => {
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
    const server = createMcpServer({
      backend: directBackend(actor),
      publicBase: process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`,
      canWrite,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
    res.on('close', () => {
      release();
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    release();
    console.error('MCP error:', e);
    if (!res.headersSent) rpcError(res, 500, 'Lỗi MCP nội bộ.');
  }
});

// Chế độ stateless: không hỗ trợ stream GET / DELETE session
app.all('/mcp', (req, res) => rpcError(res, 405, 'Chỉ hỗ trợ POST.'));

/* ---------- Kiểm tra sức khỏe ---------- */
// Frontend và hệ thống giám sát dùng để biết backend còn sống
app.get(['/', '/health'], (req, res) => {
  res.json({ name: 'feedback-backlog-backend', version, storage: storage.mode });
});

/* ---------- Error handler (multer, ...) ---------- */
app.use((err: Error & { code?: string }, req: Request, res: Response, _next: NextFunction) => {
  try {
    allFiles(req.files).forEach((f) => f.filename && removeFile('/uploads/' + f.filename));
  } catch {
    // dọn file lỗi thì bỏ qua, vẫn phải trả lời client
  }
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'File vượt quá 50MB.' : err.message || 'Lỗi hệ thống.';
  res.status(400).json({ error: message });
});

// Lỗi bất ngờ chỉ được ghi log, không làm sập tiến trình
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

export default app;

// Chạy trực tiếp (npm start / npm run dev): mở cổng. Trên Vercel, api/index.js import app và Vercel tự xử lý request.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureReady()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Feedback backlog chạy tại http://localhost:${PORT} (lưu trữ: ${storage.mode === 'pg' ? 'Postgres' : 'file JSON'})`);
      });
    })
    .catch((e) => {
      console.error('Không khởi động được:', e.message);
      process.exit(1);
    });
}
