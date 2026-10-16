import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_SESSION_NAME, verifySessionToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const sessionCookie = req.cookies.get(COOKIE_SESSION_NAME)?.value;
    const user = verifySessionToken(sessionCookie);

    return NextResponse.json({
      user: user || null,
    });
  } catch {
    return NextResponse.json({ user: null });
  }
}
