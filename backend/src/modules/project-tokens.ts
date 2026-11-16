/**
 * Token MCP theo dự án: admin cấp cho một nhân sự của dự án (tab Nhân sự), token chỉ xem được backlog của dự án đó.
 *   GET    /api/projects/:id/tokens                    (admin) danh sách token của dự án (chỉ gợi ý, không có token gốc)
 *   POST   /api/projects/:id/members/:userId/token     (admin) cấp / cấp lại token, trả token gốc đúng một lần
 *   DELETE /api/projects/:id/members/:userId/token     (admin) thu hồi
 * Token chỉ dùng cho /mcp. Không dùng được cho API quản trị (requireAdmin chỉ nhận token cá nhân / phiên).
 */
import { Router } from 'express';
import { q, q1 } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { bad, iso, isoReq, notFound, route } from '../lib/http.js';
import { TOKEN_PREFIX, newToken, hashToken, tokenHint } from '../lib/tokens.js';
import { requireAdmin, toActor } from './users.js';
import type { Actor } from './users.js';

/** Người dùng + dự án theo token dự án (còn hiệu lực khi người đó vẫn là nhân sự của dự án); không có -> null. */
export async function findProjectToken(token: string): Promise<{ actor: Actor; projectPublicId: string; tokenId: number } | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = await q1(
    `SELECT u.*, p.id_public AS project_pid, pt.id_private AS token_id
     FROM project_tokens pt
     JOIN users u ON u.id_private = pt.user_id AND u.deleted_at IS NULL
     JOIN projects p ON p.id_private = pt.project_id AND p.deleted_at IS NULL
     WHERE pt.token_hash = $1 AND pt.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pt.project_id AND pm.user_id = pt.user_id AND pm.deleted_at IS NULL)`,
    [hashToken(token)]
  );
  return row ? { actor: toActor(row), projectPublicId: row.project_pid, tokenId: row.token_id } : null;
}

const lastUsedWrites = new Map<number, number>();
/** Cập nhật last_used_at của token dự án (tối đa 1 lần / phút / instance). */
export async function touchProjectToken(tokenId: number): Promise<void> {
  const t = Date.now();
  if (t - (lastUsedWrites.get(tokenId) || 0) < 60 * 1000) return;
  lastUsedWrites.set(tokenId, t);
  await q('UPDATE project_tokens SET last_used_at = now() WHERE id_private = $1', [tokenId]).catch(() => {});
}

const audit = (actor: string, action: string, target: string): Promise<unknown> =>
  q('INSERT INTO audit_logs (id_public, actor, action, target) VALUES ($1, $2, $3, $4)', [uuidv7(), actor, action, target]);

/** Tìm (dự án, nhân sự) từ tham số URL; nhân sự phải đang tham gia dự án và còn hoạt động. */
async function resolveMember(projectPublicId: string, userPublicId: string): Promise<{ projectId: number; userId: number; projectName: string; userName: string }> {
  const projectId = (await privateId('projects', projectPublicId, true)) ?? notFound('Không tìm thấy dự án.');
  const userId = (await privateId('users', userPublicId, true)) ?? notFound('Không tìm thấy nhân sự.');
  const row = await q1(
    `SELECT p.name AS project_name, u.name AS user_name, u.active
     FROM project_members pm JOIN projects p ON p.id_private = pm.project_id JOIN users u ON u.id_private = pm.user_id
     WHERE pm.project_id = $1 AND pm.user_id = $2 AND pm.deleted_at IS NULL AND u.deleted_at IS NULL`,
    [projectId, userId]
  );
  if (!row) return bad('Người này chưa tham gia dự án. Hãy thêm vào Nhân sự của dự án trước.');
  if (!row.active) bad('Tài khoản này đang bị vô hiệu hóa.');
  return { projectId, userId, projectName: row.project_name, userName: row.user_name };
}

export const projectTokensRouter = Router();

projectTokensRouter.get(
  '/projects/:id/tokens',
  requireAdmin,
  route(async (req, res) => {
    const projectId = (await privateId('projects', req.params.id as string, true)) ?? notFound('Không tìm thấy dự án.');
    const rows = await q(
      `SELECT u.id_public AS user_pid, pt.token_hint, pt.created_at, pt.last_used_at
       FROM project_tokens pt JOIN users u ON u.id_private = pt.user_id
       WHERE pt.project_id = $1 AND pt.deleted_at IS NULL AND u.deleted_at IS NULL ORDER BY pt.id_private`,
      [projectId]
    );
    res.json(rows.map((r) => ({ userId: r.user_pid, tokenHint: r.token_hint, createdAt: isoReq(r.created_at), lastUsedAt: iso(r.last_used_at) })));
  })
);

projectTokensRouter.post(
  '/projects/:id/members/:userId/token',
  requireAdmin,
  route(async (req, res) => {
    const m = await resolveMember(req.params.id as string, req.params.userId as string);
    const token = newToken();
    await q('UPDATE project_tokens SET deleted_at = now() WHERE project_id = $1 AND user_id = $2 AND deleted_at IS NULL', [m.projectId, m.userId]);
    await q('INSERT INTO project_tokens (id_public, project_id, user_id, token_hash, token_hint) VALUES ($1, $2, $3, $4, $5)', [uuidv7(), m.projectId, m.userId, hashToken(token), tokenHint(token)]);
    await audit(req.admin?.name ?? 'admin', `cấp token dự án "${m.projectName}"`, m.userName);
    res.status(201).json({ token, user: { name: m.userName }, project: { name: m.projectName } });
  })
);

projectTokensRouter.delete(
  '/projects/:id/members/:userId/token',
  requireAdmin,
  route(async (req, res) => {
    const m = await resolveMember(req.params.id as string, req.params.userId as string);
    await q('UPDATE project_tokens SET deleted_at = now() WHERE project_id = $1 AND user_id = $2 AND deleted_at IS NULL', [m.projectId, m.userId]);
    await audit(req.admin?.name ?? 'admin', `thu hồi token dự án "${m.projectName}"`, m.userName);
    res.json({ ok: true });
  })
);
