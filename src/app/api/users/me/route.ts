import { NextRequest } from 'next/server';
import { getAuthUser, unauthorized } from '@/lib/auth';

/** Returns the current user's id, email, and role. Used by client pages to check permissions. */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  return Response.json({ email: user.email, role: user.role, name: user.name });
}
