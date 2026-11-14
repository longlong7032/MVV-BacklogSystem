/**
 * Người dùng, token cá nhân (MCP), đăng nhập quản trị (phiên), nhật ký quản trị.
 *
 *   POST   /api/admin/login          { email, password } | { token }  -> đặt cookie phiên fb_admin
 *   DELETE /api/admin/session        đăng xuất (xóa mềm phiên)
 *   GET    /api/users                (admin) danh sách người dùng
 *   GET    /api/users/audit          (admin) 50 dòng nhật ký quản trị mới nhất
 *   POST   /api/users                (admin) tạo người dùng + cấp token (token trả về đúng 1 lần)
 *   PUT    /api/users/:id            (admin) sửa
 *   POST   /api/users/:id/token      (admin) cấp lại token
 *   DELETE /api/users/:id/token      (admin) thu hồi token
 *   DELETE /api/users/:id            (admin) xóa mềm
 *   GET    /api/project-members      nhân sự đang hoạt động (không có email / thông tin xác thực) để phân công
 *
 * Quyền: read (chỉ đọc qua MCP), write (đọc + ghi), admin (ghi + quản lý người dùng).
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { q, q1, tx } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { HttpError, bad, iso, isoReq, notFound, route, str } from '../lib/http.js';
import { TOKEN_PREFIX, newToken, hashToken, tokenHint, hashPassword, verifyPassword } from '../lib/tokens.js';
import type { ProjectMember, PublicUser, Role } from '../types.js';

/** Người dùng đang thao tác (gắn vào req sau requireAdmin / xác thực MCP). */
export interface Actor {
  idPrivate: number;
  idPublic: string;
  name: string;
  role: Role;
  active: boolean;
}

declare global {
  namespace Express {
    interface Request {
      admin?: Actor;
    }
  }
}

/* ---------- Giới hạn tốc độ (in-memory, cửa sổ cố định) ---------- */

export interface Limiter {
  /** Ghi nhận 1 lần; trả về số giây phải chờ nếu vượt giới hạn, ngược lại 0. */
  hit(key: string): number;
  /** Chỉ kiểm tra; trả về số giây còn bị khóa, hoặc 0. */
  over(key: string): number;
}

export function makeLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, { count: number; reset: number }>();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs).unref();
  return {
    hit(key) {
      const t = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= t) hits.set(key, (v = { count: 0, reset: t + windowMs }));
      v.count++;
      return v.count > max ? Math.ceil((v.reset - t) / 1000) : 0;
    },
    over(key) {
      const v = hits.get(key);
      return v && v.reset > Date.now() && v.count > max ? Math.ceil((v.reset - Date.now()) / 1000) : 0;
    },
  };
}

/** DEV_NO_AUTH=1: bỏ xác thực quản trị + MCP — CHỈ dùng khi chạy local để thử. */
export const DEV_NO_AUTH = process.env.DEV_NO_AUTH === '1';
if (DEV_NO_AUTH) console.warn('[BẢO MẬT] DEV_NO_AUTH=1: quản lý người dùng và /mcp KHÔNG có xác thực — chỉ dùng khi chạy local!');

const ROLES: Role[] = ['read', 'write', 'admin'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_PREFIX = 'fbs_';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_COOKIE = 'fb_admin';
const LAST_ADMIN_ERROR = 'Đây là quản trị viên hoạt động cuối cùng — không thể hạ quyền, vô hiệu hóa, thu hồi token hoặc xóa.';
// Băm giả để mọi lần đăng nhập đều tốn thời gian như nhau (không lộ email nào tồn tại)
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const adminPerIp = makeLimiter(120, 60 * 1000); // 120 request quản trị / phút / IP
const adminBadAuth = makeLimiter(8, 15 * 60 * 1000); // sai > 8 lần / 15 phút -> khóa IP

/* ---------- Truy vấn ---------- */

const USER_COLS = `u.*, t.id_public AS team_pid`;
const USER_FROM = `users u LEFT JOIN teams t ON t.id_private = u.team_id AND t.deleted_at IS NULL`;

const toPublicUser = (r: Record<string, any>): PublicUser => ({
  idPublic: r.id_public,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
  name: r.name,
  email: r.email,
  role: r.role,
  teamId: r.team_pid || '',
  active: r.active,
  hasToken: Boolean(r.token_hash),
  hasPassword: Boolean(r.password_hash),
  tokenHint: r.token_hash ? r.token_hint : '',
  tokenCreatedAt: iso(r.token_created_at),
  lastUsedAt: iso(r.last_used_at),
});

const toActor = (r: Record<string, any>): Actor => ({ idPrivate: r.id_private, idPublic: r.id_public, name: r.name, role: r.role, active: r.active });

/** Người dùng theo token cá nhân (so khớp băm SHA-256 qua index); không có -> null. */
export async function findUserByToken(token: string): Promise<Actor | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = await q1('SELECT * FROM users WHERE token_hash = $1 AND deleted_at IS NULL', [hashToken(token)]);
  return row ? toActor(row) : null;
}

/** Người dùng theo token phiên còn hạn; không có -> null. */
async function findSessionUser(token: string): Promise<Actor | null> {
  if (!token || !token.startsWith(SESSION_PREFIX)) return null;
  const row = await q1(
    `SELECT u.* FROM sessions s JOIN users u ON u.id_private = s.user_id
     WHERE s.token_hash = $1 AND s.deleted_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return row ? toActor(row) : null;
}

/** Ghi nhật ký quản trị. */
async function audit(actor: string, action: string, target: string): Promise<void> {
  await q('INSERT INTO audit_logs (id_public, actor, action, target) VALUES ($1, $2, $3, $4)', [uuidv7(), actor, action, target]);
}

/** Có admin hoạt động (có token hoặc mật khẩu) nào không, trừ `exceptId`. */
async function hasOtherActiveAdmin(exceptId: number): Promise<boolean> {
  const row = await q1(
    `SELECT 1 FROM users WHERE deleted_at IS NULL AND role = 'admin' AND active AND (token_hash <> '' OR password_hash <> '') AND id_private <> $1 LIMIT 1`,
    [exceptId]
  );
  return Boolean(row);
}

/** `true` nếu user là admin hoạt động duy nhất còn lại. */
async function isLastAdmin(u: Record<string, any>): Promise<boolean> {
  const activeAdmin = u.role === 'admin' && u.active && (u.token_hash || u.password_hash);
  return Boolean(activeAdmin) && !(await hasOtherActiveAdmin(u.id_private));
}

const lastUsedWrites = new Map<number, number>();
/** Cập nhật last_used_at (tối đa 1 lần / phút / instance để không ghi DB quá nhiều). */
export async function touchLastUsed(userId: number): Promise<void> {
  const t = Date.now();
  if (t - (lastUsedWrites.get(userId) || 0) < 60 * 1000) return;
  lastUsedWrites.set(userId, t);
  await q('UPDATE users SET last_used_at = now() WHERE id_private = $1', [userId]).catch(() => {});
}

/* ---------- Cookie / Bearer ---------- */

export const bearer = (req: Request): string => {
  const m = /^Bearer (.{1,256})$/i.exec(req.get('authorization') || '');
  return m ? (m[1] as string) : '';
};

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

/** Đặt (hoặc xóa khi token rỗng) cookie phiên quản trị: HttpOnly + SameSite=Strict. */
function setAdminCookie(req: Request, res: Response, token: string): void {
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  res.append('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
}

/* ---------- Middleware quản trị ---------- */

/** Bảo vệ API quản trị: giới hạn tốc độ, khóa IP khi sai nhiều lần, xác thực phiên hoặc token cá nhân của admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || 'unknown';
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
    req.admin = { idPrivate: 0, idPublic: '', name: 'local', role: 'admin', active: true };
    return next();
  }
  (async () => {
    if (!(await hasOtherActiveAdmin(0))) {
      res.status(503).json({
        code: 'admin-setup',
        error: 'Chưa có quản trị viên nào. Đặt ADMIN_EMAIL + ADMIN_PASSWORD trong .env rồi khởi động lại, hoặc chạy: npm run create-admin -- "Họ tên" email@congty.vn',
      });
      return;
    }
    const credential = bearer(req) || getCookie(req, ADMIN_COOKIE);
    const user = (await findSessionUser(credential)) || (await findUserByToken(credential));
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
    await touchLastUsed(user.idPrivate);
    next();
  })().catch(next);
}

const adminName = (req: Request): string => req.admin?.name ?? 'admin';

/* ---------- Kiểm tra dữ liệu ---------- */

async function validateUser(body: Record<string, unknown>, selfId?: number): Promise<{ name: string; email: string; role: Role; teamId: number | null; active: boolean }> {
  const name = str(body.name);
  if (!name) bad('Vui lòng nhập tên người dùng.');
  if (name.length > 120) bad('Tên tối đa 120 ký tự.');
  const email = str(body.email).toLowerCase();
  if (!email) bad('Vui lòng nhập email.');
  if (email.length > 200 || !EMAIL_RE.test(email)) bad('Email không hợp lệ.');
  if (await q1('SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL AND id_private <> $2', [email, selfId ?? 0])) bad(`Email "${email}" đã được dùng.`);
  const role = (str(body.role) || 'read') as Role;
  if (!ROLES.includes(role)) bad('Quyền không hợp lệ.');
  const teamPublic = str(body.teamId);
  const teamId = teamPublic ? ((await privateId('teams', teamPublic)) ?? bad('Team không tồn tại.')) : null;
  return { name, email, role, teamId, active: body.active === undefined ? true : body.active === true };
}

/** Cấp token mới (ghi đè token cũ). Trả về token gốc — chỉ đúng một lần, DB chỉ lưu băm. */
async function issueToken(userId: number): Promise<string> {
  const token = newToken();
  await q('UPDATE users SET token_hash = $2, token_hint = $3, token_created_at = now(), last_used_at = NULL WHERE id_private = $1', [userId, hashToken(token), tokenHint(token)]);
  return token;
}

async function loadUser(id: number): Promise<Record<string, any>> {
  return (await q1(`SELECT ${USER_COLS} FROM ${USER_FROM} WHERE u.id_private = $1`, [id]))!;
}

/** Gỡ người dùng khỏi các dự án và backlog đang giao (khi vô hiệu hóa / xóa). */
async function detachUser(id: number): Promise<void> {
  await q('UPDATE project_members SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [id]);
  await q('UPDATE feedbacks SET assignee_id = NULL WHERE assignee_id = $1', [id]);
}

/* ---------- Admin cứng từ .env ---------- */

/**
 * ADMIN_EMAIL + ADMIN_PASSWORD trong .env -> mỗi lần khởi động đảm bảo tài khoản này tồn tại, là admin,
 * đang hoạt động và có đúng mật khẩu đó (chỉ lưu băm).
 */
export async function seedAdmin(): Promise<void> {
  const email = str(process.env.ADMIN_EMAIL).toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return;
  if (!EMAIL_RE.test(email) || password.length < 8) {
    console.warn('[Admin] ADMIN_EMAIL không hợp lệ hoặc ADMIN_PASSWORD ngắn hơn 8 ký tự -> bỏ qua admin cứng.');
    return;
  }
  await tx(async () => {
    let user = await q1('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE', [email]);
    let changed = false;
    if (!user) {
      user = await q1('INSERT INTO users (id_public, name, email, role) VALUES ($1, $2, $3, $4) RETURNING *', [uuidv7(), str(process.env.ADMIN_NAME) || email.split('@')[0], email, 'admin']);
      changed = true;
    }
    if (user!.role !== 'admin' || !user!.active) {
      await q("UPDATE users SET role = 'admin', active = true WHERE id_private = $1", [user!.id_private]);
      changed = true;
    }
    if (!verifyPassword(password, user!.password_hash)) {
      await q('UPDATE users SET password_hash = $2 WHERE id_private = $1', [user!.id_private, hashPassword(password)]);
      changed = true;
    }
    if (changed) {
      await audit('hệ thống', 'đảm bảo admin cứng từ .env', user!.name);
      console.log(`[Admin] Đã đảm bảo admin: ${user!.name} <${email}>`);
    }
  });
}

/* ---------- Routes ---------- */

export const usersRouter = Router();

usersRouter.post(
  '/admin/login',
  route(async (req, res) => {
    const ip = req.ip || 'unknown';
    const locked = adminBadAuth.over(ip);
    if (locked) {
      res.setHeader('Retry-After', String(locked));
      throw new HttpError(429, `Sai thông tin đăng nhập quá nhiều lần, thử lại sau ${locked}s.`, 'admin-locked');
    }
    const wait = adminPerIp.hit(ip);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw new HttpError(429, `Quá nhiều yêu cầu, thử lại sau ${wait}s.`);
    }
    const body = req.body || {};
    const personalToken = typeof body.token === 'string' ? body.token.trim().slice(0, 256) : '';
    let user: Actor | null = null;
    if (personalToken) {
      user = await findUserByToken(personalToken);
    } else {
      const email = str(body.email).toLowerCase().slice(0, 200);
      const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
      const row = await q1("SELECT * FROM users WHERE email = $1 AND password_hash <> '' AND deleted_at IS NULL", [email]);
      // luôn băm mật khẩu (kể cả khi email không tồn tại) để thời gian xử lý không lộ thông tin
      const ok = verifyPassword(password, row ? row.password_hash : DUMMY_PASSWORD_HASH);
      user = ok && row ? toActor(row) : null;
    }
    if (!user) {
      adminBadAuth.hit(ip);
      throw new HttpError(401, personalToken ? 'Token không đúng.' : 'Email hoặc mật khẩu không đúng.', 'admin-auth');
    }
    if (!user.active || user.role !== 'admin') throw new HttpError(403, 'Tài khoản này không có quyền quản trị.', 'admin-forbidden');
    const token = SESSION_PREFIX + crypto.randomBytes(32).toString('base64url');
    await q("INSERT INTO sessions (id_public, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')", [uuidv7(), user.idPrivate, hashToken(token), SESSION_TTL_MS]);
    await audit(user.name, 'đăng nhập quản trị', user.name);
    setAdminCookie(req, res, token);
    res.json({ token, name: user.name });
  })
);

usersRouter.delete(
  '/admin/session',
  route(async (req, res) => {
    const token = bearer(req) || getCookie(req, ADMIN_COOKIE);
    if (token.startsWith(SESSION_PREFIX)) await q('UPDATE sessions SET deleted_at = now() WHERE token_hash = $1 AND deleted_at IS NULL', [hashToken(token)]);
    setAdminCookie(req, res, '');
    res.json({ ok: true });
  })
);

usersRouter.get(
  '/project-members',
  route(async (req, res) => {
    const rows = await q(`SELECT u.id_public, u.name, u.role, t.id_public AS team_pid FROM ${USER_FROM} WHERE u.deleted_at IS NULL AND u.active ORDER BY u.name`);
    const list: ProjectMember[] = rows.map((r) => ({ idPublic: r.id_public, name: r.name, teamId: r.team_pid || '', role: r.role }));
    res.json(list);
  })
);

usersRouter.get(
  '/users',
  requireAdmin,
  route(async (req, res) => {
    res.json((await q(`SELECT ${USER_COLS} FROM ${USER_FROM} WHERE u.deleted_at IS NULL ORDER BY u.created_at`)).map(toPublicUser));
  })
);

usersRouter.get(
  '/users/audit',
  requireAdmin,
  route(async (req, res) => {
    const rows = await q('SELECT * FROM audit_logs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50');
    res.json(rows.map((r) => ({ idPublic: r.id_public, createdAt: isoReq(r.created_at), updatedAt: isoReq(r.updated_at), actor: r.actor, action: r.action, target: r.target })));
  })
);

usersRouter.post(
  '/users',
  requireAdmin,
  route(async (req, res) => {
    const v = await validateUser(req.body || {});
    const row = await q1('INSERT INTO users (id_public, name, email, role, team_id, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_private', [uuidv7(), v.name, v.email, v.role, v.teamId, v.active]);
    const token = await issueToken(row!.id_private);
    await audit(adminName(req), `tạo người dùng (${v.role})`, v.name);
    res.status(201).json({ user: toPublicUser(await loadUser(row!.id_private)), token });
  })
);

usersRouter.put(
  '/users/:id',
  requireAdmin,
  route(async (req, res) => {
    const id = (await privateId('users', req.params.id as string, true)) ?? notFound('Không tìm thấy người dùng.');
    const before = await loadUser(id);
    const v = await validateUser({ active: before.active, ...(req.body || {}) }, id);
    if ((await isLastAdmin(before)) && (v.role !== 'admin' || !v.active)) bad(LAST_ADMIN_ERROR);
    await q('UPDATE users SET name = $2, email = $3, role = $4, team_id = $5, active = $6 WHERE id_private = $1', [id, v.name, v.email, v.role, v.teamId, v.active]);
    if (!v.active) await detachUser(id);
    const changes: string[] = [];
    if (v.role !== before.role) changes.push(`quyền ${before.role} → ${v.role}`);
    if (v.active !== before.active) changes.push(v.active ? 'kích hoạt' : 'vô hiệu hóa');
    await audit(adminName(req), `sửa người dùng${changes.length ? ' (' + changes.join(', ') + ')' : ''}`, v.name);
    res.json(toPublicUser(await loadUser(id)));
  })
);

usersRouter.post(
  '/users/:id/token',
  requireAdmin,
  route(async (req, res) => {
    const id = (await privateId('users', req.params.id as string, true)) ?? notFound('Không tìm thấy người dùng.');
    const token = await issueToken(id);
    const user = await loadUser(id);
    await audit(adminName(req), 'cấp lại token', user.name);
    res.json({ user: toPublicUser(user), token });
  })
);

usersRouter.delete(
  '/users/:id/token',
  requireAdmin,
  route(async (req, res) => {
    const id = (await privateId('users', req.params.id as string, true)) ?? notFound('Không tìm thấy người dùng.');
    const before = await loadUser(id);
    if (await isLastAdmin(before)) bad(LAST_ADMIN_ERROR);
    await q("UPDATE users SET token_hash = '', token_hint = '', token_created_at = NULL WHERE id_private = $1", [id]);
    await audit(adminName(req), 'thu hồi token', before.name);
    res.json(toPublicUser(await loadUser(id)));
  })
);

usersRouter.delete(
  '/users/:id',
  requireAdmin,
  route(async (req, res) => {
    const id = (await privateId('users', req.params.id as string, true)) ?? notFound('Không tìm thấy người dùng.');
    const before = await loadUser(id);
    if (await isLastAdmin(before)) bad(LAST_ADMIN_ERROR);
    await q("UPDATE users SET deleted_at = now(), token_hash = '' WHERE id_private = $1", [id]);
    await q('UPDATE sessions SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [id]);
    await detachUser(id);
    await audit(adminName(req), 'xóa người dùng', before.name);
    res.json({ ok: true });
  })
);
