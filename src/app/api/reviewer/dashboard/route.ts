import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const [[dbUser]] = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = ?', [user.uid]
  ) as any;
  const userId = dbUser?.id;

  // All queries run in parallel — O(log n) each with composite indexes
  const [
    [[{ pending }]],
    [[personalStats]],
    [[{ corrections_approved }]],
    [recentActivity],
    [assignedSources],
    [[oldestPending]],
  ] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS pending FROM raw_events WHERE status IN ('pending','pending_fix')`
    ),
    pool.query(
      `SELECT
         COUNT(*) AS total_reviewed,
         SUM(action = 'approved') AS total_approved,
         SUM(action = 'rejected') AS total_rejected,
         SUM(action = 'sent_for_correction') AS total_sent_for_correction,
         ROUND(AVG(time_spent_sec), 1) AS avg_time_sec,
         SUM(action = 'approved' AND created_at >= CURDATE()) AS approved_today,
         SUM(action = 'rejected' AND created_at >= CURDATE()) AS rejected_today
       FROM review_sessions WHERE reviewer_id = ?`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*) AS corrections_approved
       FROM review_sessions rs
       JOIN raw_events fixed ON fixed.corrected_from_id = rs.raw_event_id
         AND fixed.status = 'approved'
       WHERE rs.reviewer_id = ? AND rs.action = 'sent_for_correction'`,
      [userId]
    ),
    pool.query(
      `SELECT rs.action, rs.time_spent_sec, rs.created_at,
              re.title, re.event_type, s.name AS source_name
       FROM review_sessions rs
       JOIN raw_events re ON rs.raw_event_id = re.id
       JOIN sources s ON re.source_id = s.id
       WHERE rs.reviewer_id = ?
       ORDER BY rs.created_at DESC LIMIT 10`,
      [userId]
    ),
    pool.query(
      `SELECT s.id, s.name, s.slug,
         SUM(re.status IN ('pending','pending_fix')) AS pending_count
       FROM sources s
       LEFT JOIN raw_events re ON re.source_id = s.id
       WHERE s.active = 1
       GROUP BY s.id, s.name, s.slug
       ORDER BY s.name`
    ),
    pool.query(
      `SELECT re.title, re.created_at, s.name AS source_name
       FROM raw_events re JOIN sources s ON re.source_id = s.id
       WHERE re.status IN ('pending','pending_fix')
       ORDER BY re.created_at ASC LIMIT 1`
    ),
  ]) as any;

  return Response.json({
    pending,
    personal_stats: { ...personalStats, corrections_approved },
    recent_activity: recentActivity,
    assigned_sources: assignedSources,
    oldest_pending: oldestPending || null,
  });
}
