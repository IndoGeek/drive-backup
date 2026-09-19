import { NextResponse } from 'next/server';
import { currentUser, publicUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const user = currentUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ user: publicUser(user) });
}
