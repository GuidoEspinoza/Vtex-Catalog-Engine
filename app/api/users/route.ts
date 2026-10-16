import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { COOKIE_SESSION_NAME, verifySessionToken } from '@/lib/auth';

function checkAdmin(req: NextRequest) {
  const roleHeader = req.headers.get('x-user-role');
  if (roleHeader === 'admin') return true;

  const token = req.cookies.get(COOKIE_SESSION_NAME)?.value;
  const user = verifySessionToken(token);
  return user?.role === 'admin';
}

export async function GET(req: NextRequest) {
  try {
    if (!checkAdmin(req)) {
      return NextResponse.json(
        { error: 'Prohibido: Se requieren permisos de administrador.' },
        { status: 403 }
      );
    }

    const { data: users, error } = await supabaseAdmin
      .from('app_users')
      .select('id, email, role, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ users: users || [] });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Error listando usuarios: ${err.message || err}` },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!checkAdmin(req)) {
      return NextResponse.json(
        { error: 'Prohibido: Se requieren permisos de administrador.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const rawEmail = body.email;
    const rawRole = body.role || 'internal';
    const password = body.password;

    if (!rawEmail || typeof rawEmail !== 'string') {
      return NextResponse.json({ error: 'El correo electrónico es requerido.' }, { status: 400 });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return NextResponse.json(
        { error: 'La contraseña es requerida y debe tener al menos 6 caracteres.' },
        { status: 400 }
      );
    }

    const email = rawEmail.toLowerCase().trim();
    const role = rawRole === 'admin' ? 'admin' : 'internal';

    if (!email.endsWith('@nexitty.com')) {
      return NextResponse.json(
        { error: 'Restricción de seguridad: Solo se permiten correos con dominio @nexitty.com.' },
        { status: 400 }
      );
    }

    // 1. Verificar si ya existe en app_users
    const { data: existingAppUser } = await supabaseAdmin
      .from('app_users')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();

    if (existingAppUser) {
      return NextResponse.json(
        { error: `El correo ${email} ya está registrado en el sistema.` },
        { status: 409 }
      );
    }

    // 2. Crear o actualizar en Supabase Auth
    // Primero verificar si ya existe en Auth
    const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
    const existingAuthUser = authList?.users?.find(
      (u) => u.email?.toLowerCase() === email
    );

    let authUserId: string;

    if (existingAuthUser) {
      authUserId = existingAuthUser.id;
      // Actualizar contraseña del usuario existente
      const { error: updateAuthErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        password,
        email_confirm: true,
        user_metadata: { role },
      });
      if (updateAuthErr) {
        return NextResponse.json(
          { error: `Error configurando credenciales de usuario: ${updateAuthErr.message}` },
          { status: 500 }
        );
      }
    } else {
      // Crear nuevo usuario en Supabase Auth
      const { data: newAuthData, error: createAuthErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role },
      });

      if (createAuthErr || !newAuthData.user) {
        return NextResponse.json(
          { error: `Error creando usuario en autenticación: ${createAuthErr?.message || 'Error desconocido'}` },
          { status: 500 }
        );
      }
      authUserId = newAuthData.user.id;
    }

    // 3. Insertar en tabla app_users
    const { data: newAppUser, error: insertError } = await supabaseAdmin
      .from('app_users')
      .insert([{ email, role }])
      .select()
      .single();

    if (insertError) {
      return NextResponse.json(
        { error: `Error guardando usuario en tabla interna: ${insertError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Usuario ${email} (${role}) creado exitosamente con contraseña asignada.`,
      user: newAppUser,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Error procesando creación de usuario: ${err.message || err}` },
      { status: 500 }
    );
  }
}
