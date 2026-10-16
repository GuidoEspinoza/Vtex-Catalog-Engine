import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { COOKIE_SESSION_NAME, verifySessionToken } from '@/lib/auth';

function getAuthenticatedUser(req: NextRequest) {
  const token = req.cookies.get(COOKIE_SESSION_NAME)?.value;
  return verifySessionToken(token);
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const adminUser = getAuthenticatedUser(req);
    if (!adminUser || adminUser.role !== 'admin') {
      return NextResponse.json(
        { error: 'Prohibido: Se requieren permisos de administrador.' },
        { status: 403 }
      );
    }

    const { id } = await context.params;

    if (!id) {
      return NextResponse.json({ error: 'ID de usuario requerido.' }, { status: 400 });
    }

    // 1. Obtener usuario a eliminar
    const { data: targetUser, error: findError } = await supabaseAdmin
      .from('app_users')
      .select('id, email, role')
      .eq('id', id)
      .single();

    if (findError || !targetUser) {
      return NextResponse.json({ error: 'Usuario no encontrado.' }, { status: 404 });
    }

    // 2. Proteger para que el admin no se auto-elimine
    if (targetUser.id === adminUser.id || targetUser.email.toLowerCase() === adminUser.email.toLowerCase()) {
      return NextResponse.json(
        { error: 'Seguridad: No puedes eliminar tu propia cuenta de administrador.' },
        { status: 400 }
      );
    }

    // 3. Eliminar de la tabla app_users
    const { error: deleteDbError } = await supabaseAdmin
      .from('app_users')
      .delete()
      .eq('id', id);

    if (deleteDbError) {
      return NextResponse.json({ error: deleteDbError.message }, { status: 500 });
    }

    // 4. Eliminar también de Supabase Auth si existe
    try {
      const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
      const authUser = authList?.users?.find(
        (u) => u.email?.toLowerCase() === targetUser.email.toLowerCase()
      );
      if (authUser) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.id);
      }
    } catch (authErr) {
      console.warn('Aviso: no se pudo eliminar de Auth o ya no existía:', authErr);
    }

    return NextResponse.json({
      success: true,
      message: `Acceso revocado para el usuario ${targetUser.email}.`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Error eliminando usuario: ${err.message || err}` },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const adminUser = getAuthenticatedUser(req);
    if (!adminUser || adminUser.role !== 'admin') {
      return NextResponse.json(
        { error: 'Prohibido: Se requieren permisos de administrador.' },
        { status: 403 }
      );
    }

    const { id } = await context.params;
    const body = await req.json();
    const { role, password } = body;

    // 1. Obtener usuario de app_users
    const { data: targetUser, error: findError } = await supabaseAdmin
      .from('app_users')
      .select('id, email, role')
      .eq('id', id)
      .single();

    if (findError || !targetUser) {
      return NextResponse.json({ error: 'Usuario no encontrado.' }, { status: 404 });
    }

    // 2. Si se solicitó actualizar rol
    if (role && (role === 'admin' || role === 'internal')) {
      // Proteger que el admin no se degrade a sí mismo sin querer
      if (
        targetUser.email.toLowerCase() === adminUser.email.toLowerCase() &&
        role !== 'admin'
      ) {
        return NextResponse.json(
          { error: 'Seguridad: No puedes quitarte a ti mismo el rol de administrador.' },
          { status: 400 }
        );
      }

      const { error: roleErr } = await supabaseAdmin
        .from('app_users')
        .update({ role })
        .eq('id', id);

      if (roleErr) {
        return NextResponse.json({ error: roleErr.message }, { status: 500 });
      }
    }

    // 3. Si se solicitó actualizar o resetear contraseña
    if (password) {
      if (typeof password !== 'string' || password.length < 6) {
        return NextResponse.json(
          { error: 'La nueva contraseña debe tener al menos 6 caracteres.' },
          { status: 400 }
        );
      }

      // Buscar en Supabase Auth
      const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
      const authUser = authList?.users?.find(
        (u) => u.email?.toLowerCase() === targetUser.email.toLowerCase()
      );

      if (authUser) {
        const { error: passErr } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          password,
        });
        if (passErr) {
          return NextResponse.json(
            { error: `Error actualizando contraseña en Auth: ${passErr.message}` },
            { status: 500 }
          );
        }
      } else {
        // Si no existía en Auth, crearlo
        const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email: targetUser.email,
          password,
          email_confirm: true,
          user_metadata: { role: targetUser.role },
        });
        if (createErr) {
          return NextResponse.json(
            { error: `Error creando credenciales en Auth: ${createErr.message}` },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Usuario ${targetUser.email} actualizado exitosamente.`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Error actualizando usuario: ${err.message || err}` },
      { status: 500 }
    );
  }
}
