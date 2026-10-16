import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { COOKIE_SESSION_NAME, verifySessionToken } from '@/lib/auth';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session',
  '/_next',
  '/favicon.ico',
  '/robots.txt',
  '/templates',
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Permitir acceso directo a rutas públicas y estáticos
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'))) {
    return NextResponse.next();
  }

  // Verificar token criptográfico HMAC en la cookie de sesión
  const sessionToken = request.cookies.get(COOKIE_SESSION_NAME)?.value;
  const user = verifySessionToken(sessionToken);

  if (!user) {
    // Si es una petición a la API, responder con 401 Unauthorized en JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'No autorizado: sesión no válida o expirada.' },
        { status: 401 }
      );
    }

    // Para páginas web, redirigir a la pantalla de login
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') {
      loginUrl.searchParams.set('redirect', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Si intenta acceder a rutas de gestión de usuarios y no es admin, denegar
  if (pathname.startsWith('/api/users') && user.role !== 'admin') {
    return NextResponse.json(
      { error: 'Prohibido: Se requieren permisos de administrador.' },
      { status: 403 }
    );
  }

  const response = NextResponse.next();
  response.headers.set('x-user-id', user.id);
  response.headers.set('x-user-email', user.email);
  response.headers.set('x-user-role', user.role);
  return response;
}

export const config = {
  matcher: [
    /*
     * Aplica a todas las rutas excepto estáticos de Next.js
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
