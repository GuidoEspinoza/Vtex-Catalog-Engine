import { NextResponse } from 'next/server';
import { COOKIE_SESSION_NAME } from '@/lib/auth';

export async function POST() {
  const response = NextResponse.json({ success: true, message: 'Sesión cerrada' });
  response.cookies.delete(COOKIE_SESSION_NAME);
  return response;
}
