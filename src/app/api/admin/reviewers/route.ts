import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

/**
 * GET /api/admin/reviewers
 * Returns all reviewers with all-time stats + full action history.
 * Optional ?reviewer_id=N to fetch detailed history for one reviewer.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { searchParams } = new URL(req.url);
  const reviewerId = searchParams.get('reviewer_id');

  // Per-reviewer all-time stats
  const [reviewers] = await pool.query(
    `SELECT
       u.id, u.full_name, u.email, u.role, u.active, u.created_at AS joined_at,
       COUNT(rs.id)                                  AS total_reviewed,
       SUM(rs.action = 'approved')                   AS approved,
       SUM(rs.action = 'rejected')                   AS rejected,
       SUM(rs.action = 'sent_for_correction')        AS sent_for_correction,
       ROUND(AVG(rs.time_spent_sec), 0)              AS avg_time_sec,
       MIN(rs.created_at)                            AS first_action,
       MAX(rs.created_at)                            AS last_action
     FROM users u
     LEFT JOIN review_sessions rs ON rs.reviewer_id = u.id
     WHERE u.role IN ('admin','reviewer') AND u.active = 1
     ${reviewerId ? 'AND u.id = ?' : ''}
     GROUP BY u.id
     ORDER BY total_reviewed DESC`,
    reviewerId ? [reviewerId] : []
  ) as any;

  // If a specific reviewer is requested, include their full history
  let history: any[] = [];
  if (reviewerId) {
    const [rows] = await pool.query(
      `SELECT
         rs.id, rs.action, rs.time_spent_sec, rs.created_at,
         re.id AS event_id, re.title AS event_title, re.status AS event_status,
         s.name AS source_name
       FROM review_sessions rs
       JOIN raw_events re ON rs.raw_event_id = re.id
       LEFT JOIN sources s ON re.source_id = s.id
       WHERE rs.reviewer_id = ?
       ORDER BY rs.created_at DESC`,
      [reviewerId]
    ) as any;
    history = rows;
  }

  return Response.json({ reviewers, history });
}
