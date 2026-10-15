import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_SESSION_NAME, createSessionToken } from '@/lib/auth';
import { checkLoginRateLimit, recordFailedLogin, resetLoginAttempts } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  try {
    // Extraer IP del cliente para rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';

    // Verificar rate limit
    const rateCheck = checkLoginRateLimit(ip);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          error: `Demasiados intentos fallidos. Acceso bloqueado temporalmente. Intenta nuevamente en ${rateCheck.retryAfterSeconds} segundos.`,
        },
        { status: 429 }
      );
    }

    const body = await request.json();
    const password = body?.password;
    const masterPassword = process.env.AUTH_PASSWORD;

    if (!masterPassword) {
      return NextResponse.json(
        { error: 'AUTH_PASSWORD no configurado en el servidor.' },
        { status: 500 }
      );
    }

    if (!password || password !== masterPassword) {
      recordFailedLogin(ip);
      const remaining = Math.max(0, rateCheck.remainingAttempts - 1);
      return NextResponse.json(
        {
          error: `Contraseña incorrecta.${remaining > 0 ? ` Te quedan ${remaining} intentos antes del bloqueo.` : ' Acceso bloqueado por 15 minutos.'}`,
        },
        { status: 401 }
      );
    }

    // Login exitoso: restablecer intentos
    resetLoginAttempts(ip);

    // Generar token derivado criptográfico (HMAC)
    const sessionToken = createSessionToken(masterPassword);

    const response = NextResponse.json({ success: true, message: 'Autenticación exitosa' });

    // Inyectar cookie HTTP-Only protegida
    response.cookies.set({
      name: COOKIE_SESSION_NAME,
      value: sessionToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 días
    });

    return response;
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida' }, { status: 400 });
  }
}
