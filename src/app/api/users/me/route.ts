import { NextRequest } from 'next/server';
import { getAuthUser, unauthorized } from '@/lib/auth';
import pool from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const [[row]] = await pool.query(
    'SELECT id, onboarded_at FROM users WHERE email = ?', [user.email]
  ) as any;

  return Response.json({
    id:         row?.id,
    email:      user.email,
    role:       user.role,
    name:       user.name,
    onboarded:  !!row?.onboarded_at,
  });
}

export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  await pool.query(
    'UPDATE users SET onboarded_at = NOW() WHERE email = ? AND onboarded_at IS NULL',
    [user.email]
  );

  return Response.json({ ok: true });
}
