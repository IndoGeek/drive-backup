import { NextResponse } from 'next/server';
import { currentUser, publicUser } from '@/lib/auth';
import { sudoStatus } from '@/lib/sudo';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const user = currentUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // `sudo` is the live view (is a password needed, is an elevation grant active),
  // on top of the account facts in publicUser.
  return NextResponse.json({
    user: { ...publicUser(user), sudo: await sudoStatus(req, user.username) },
  });
}
