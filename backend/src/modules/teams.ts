/**
 * Team xử lý backlog.
 *   GET    /api/teams
 *   POST   /api/teams            { name, lead?, description? }
 *   PUT    /api/teams/:id        { name, lead?, description? }
 *   DELETE /api/teams/:id        xóa mềm; backlog / người dùng đang thuộc team -> "chưa phân công"
 */
import { Router } from 'express';
import { q, q1 } from '../db/pool.js';
import { privateId } from '../db/ids.js';
import { uuidv7 } from '../lib/ids.js';
import { bad, isoReq, notFound, route, sameName, str } from '../lib/http.js';
import type { Team } from '../types.js';

const toTeam = (r: Record<string, any>): Team => ({
  idPublic: r.id_public,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
  name: r.name,
  lead: r.lead,
  description: r.description,
});

export async function listTeams(): Promise<Team[]> {
  return (await q('SELECT * FROM teams WHERE deleted_at IS NULL ORDER BY name')).map(toTeam);
}

/** Kiểm tra dữ liệu team (tên không trùng — không phân biệt hoa/thường và dấu). */
async function validate(body: Record<string, unknown>, selfId?: number): Promise<{ name: string; lead: string; description: string }> {
  const name = str(body.name);
  if (!name) bad('Vui lòng nhập tên team.');
  if (name.length > 120) bad('Tên team tối đa 120 ký tự.');
  const others = await q<{ name: string }>('SELECT name FROM teams WHERE deleted_at IS NULL AND id_private <> $1', [selfId ?? 0]);
  if (others.some((t) => sameName(t.name, name))) bad(`Team "${name}" đã tồn tại.`);
  const lead = str(body.lead);
  if (lead.length > 120) bad('Tên trưởng nhóm tối đa 120 ký tự.');
  return { name, lead, description: str(body.description) };
}

export const teamsRouter = Router();

teamsRouter.get('/teams', route(async (req, res) => void res.json(await listTeams())));

teamsRouter.post(
  '/teams',
  route(async (req, res) => {
    const v = await validate(req.body || {});
    const row = await q1('INSERT INTO teams (id_public, name, lead, description) VALUES ($1, $2, $3, $4) RETURNING *', [uuidv7(), v.name, v.lead, v.description]);
    res.status(201).json(toTeam(row!));
  })
);

teamsRouter.put(
  '/teams/:id',
  route(async (req, res) => {
    const id = (await privateId('teams', req.params.id as string, true)) ?? notFound('Không tìm thấy team.');
    const v = await validate(req.body || {}, id);
    const row = await q1('UPDATE teams SET name = $2, lead = $3, description = $4 WHERE id_private = $1 RETURNING *', [id, v.name, v.lead, v.description]);
    res.json(toTeam(row!));
  })
);

teamsRouter.delete(
  '/teams/:id',
  route(async (req, res) => {
    const id = (await privateId('teams', req.params.id as string, true)) ?? notFound('Không tìm thấy team.');
    await q('UPDATE teams SET deleted_at = now() WHERE id_private = $1', [id]);
    const unassigned = await q('UPDATE feedbacks SET team_id = NULL WHERE team_id = $1 AND deleted_at IS NULL RETURNING id_private', [id]);
    await q('UPDATE users SET team_id = NULL WHERE team_id = $1', [id]);
    res.json({ ok: true, unassigned: unassigned.length });
  })
);
