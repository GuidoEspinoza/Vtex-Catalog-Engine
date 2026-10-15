import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { COOKIE_SESSION_NAME, verifySessionToken } from '@/lib/auth';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/_next',
  '/favicon.ico',
  '/robots.txt',
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Permitir acceso directo a rutas públicas
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'))) {
    return NextResponse.next();
  }

  // Verificar token criptográfico en la cookie
  const sessionToken = request.cookies.get(COOKIE_SESSION_NAME)?.value;
  const masterPassword = process.env.AUTH_PASSWORD;

  const isValidSession = verifySessionToken(sessionToken, masterPassword);

  if (!isValidSession) {
    // Si es una petición a la API, responder con 401 Unauthorized en JSON (no redirigir con HTML)
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

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Aplica a todas las rutas excepto recursos estáticos e imágenes
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
