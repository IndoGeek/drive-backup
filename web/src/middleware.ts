import { NextResponse, type NextRequest } from 'next/server';

const COOKIE_NAME = 'bm_session';

function hasPlausibleSession(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [uid, exp, sig] = parts;
  if (!uid || !exp || !sig) return false;
  const expMs = Number(exp);
  return Number.isInteger(Number(uid)) && !Number.isNaN(expMs) && expMs > Date.now();
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login' || pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }
  if (hasPlausibleSession(req.cookies.get(COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
