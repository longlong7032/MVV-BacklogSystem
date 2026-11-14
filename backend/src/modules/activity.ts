/**
 * Nhật ký thay đổi theo dự án (backlog, thanh toán, tài liệu PTYC).
 *   GET /api/activity?project=<idPublic>   300 dòng mới nhất
 */
import { Router } from 'express';
import { q } from '../db/pool.js';
import { uuidv7 } from '../lib/ids.js';
import { isoReq, route, uuidParam } from '../lib/http.js';
import type { ActivityEntry } from '../types.js';

export interface ActivityInput {
  projectId: number | null;
  entityType: ActivityEntry['entityType'];
  entityPublicId: string | null;
  entityTitle: string;
  action: ActivityEntry['action'];
  actor: string;
  details: string[];
}

/** Ghi một dòng nhật ký (trong transaction hiện tại). */
export async function recordActivity(e: ActivityInput): Promise<void> {
  await q(
    `INSERT INTO activity_logs (id_public, project_id, entity_type, entity_public_id, entity_title, action, actor, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuidv7(), e.projectId, e.entityType, e.entityPublicId, e.entityTitle.slice(0, 300), e.action, e.actor, JSON.stringify(e.details)]
  );
}

export const activityRouter = Router();

activityRouter.get(
  '/activity',
  route(async (req, res) => {
    const project = uuidParam(req.query.project);
    const rows = await q(
      `SELECT a.id_public, a.created_at, a.updated_at, p.id_public AS project_pid, a.entity_type, a.entity_public_id,
              a.entity_title, a.action, a.actor, a.details
       FROM activity_logs a LEFT JOIN projects p ON p.id_private = a.project_id
       WHERE a.deleted_at IS NULL AND ($1::uuid IS NULL OR p.id_public = $1::uuid)
       ORDER BY a.created_at DESC LIMIT 300`,
      [project || null]
    );
    const list: ActivityEntry[] = rows.map((r) => ({
      idPublic: r.id_public,
      createdAt: isoReq(r.created_at),
      updatedAt: isoReq(r.updated_at),
      projectId: r.project_pid || '',
      entityType: r.entity_type,
      entityId: r.entity_public_id || '',
      entityTitle: r.entity_title,
      action: r.action,
      actor: r.actor,
      details: Array.isArray(r.details) ? r.details : [],
    }));
    res.json(list);
  })
);
