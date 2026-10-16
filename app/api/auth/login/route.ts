import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabasePublic } from '@/lib/supabase';
import { createSessionToken, COOKIE_SESSION_NAME } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email: rawEmail, password } = body;

    if (!rawEmail || typeof rawEmail !== 'string') {
      return NextResponse.json(
        { error: 'El correo electrónico es requerido.' },
        { status: 400 }
      );
    }
    if (!password || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'La contraseña es requerida.' },
        { status: 400 }
      );
    }

    const email = rawEmail.toLowerCase().trim();

    // 1. Validar dominio corporativo @nexitty.com
    if (!email.endsWith('@nexitty.com')) {
      return NextResponse.json(
        { error: 'Restricción de acceso: Solo se permiten correos corporativos @nexitty.com.' },
        { status: 403 }
      );
    }

    // 2. Verificar que el usuario esté autorizado en la tabla app_users y obtener su rol
    const { data: appUser, error: appUserErr } = await supabaseAdmin
      .from('app_users')
      .select('id, email, role')
      .eq('email', email)
      .maybeSingle();

    if (appUserErr) {
      console.error('Error consultando app_users:', appUserErr);
      return NextResponse.json(
        { error: 'Error al verificar credenciales internas en la base de datos.' },
        { status: 500 }
      );
    }

    if (!appUser) {
      return NextResponse.json(
        { error: 'Acceso no autorizado. Tu cuenta no está registrada en el panel interno. Contacta al administrador.' },
        { status: 403 }
      );
    }

    // 3. Autenticar correo y contraseña en Supabase Auth
    const { data: authData, error: authError } = await supabasePublic.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      return NextResponse.json(
        { error: 'Correo o contraseña incorrectos. Verifica tus credenciales.' },
        { status: 401 }
      );
    }

    // 4. Generar token de sesión firmado HMAC (vigencia 7 días)
    const sessionToken = createSessionToken({
      id: authData.user.id,
      email: authData.user.email || email,
      role: appUser.role === 'admin' ? 'admin' : 'internal',
      name: email.split('@')[0],
    });

    const response = NextResponse.json({
      success: true,
      message: 'Inicio de sesión exitoso.',
      user: {
        id: authData.user.id,
        email,
        role: appUser.role,
      },
    });

    // 5. Configurar cookie segura HttpOnly
    response.cookies.set(COOKIE_SESSION_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 días
    });

    return response;
  } catch (err: any) {
    console.error('Error inesperado en login:', err);
    return NextResponse.json(
      { error: `Error interno de autenticación: ${err.message || err}` },
      { status: 500 }
    );
  }
}
