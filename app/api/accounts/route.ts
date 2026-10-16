import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { COOKIE_SESSION_NAME, verifySessionToken } from '@/lib/auth';

function checkAdmin(req: NextRequest): boolean {
  const roleHeader = req.headers.get('x-user-role');
  if (roleHeader === 'admin') return true;

  const token = req.cookies.get(COOKIE_SESSION_NAME)?.value;
  const user = verifySessionToken(token);
  return user?.role === 'admin';
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('vtex_accounts')
      .select('id, company_name, account_name, environment, is_active, created_at, updated_at')
      .order('company_name', { ascending: true });

    if (error) {
      // Si la tabla no existe aún en Supabase, devolvemos un array vacío controlado y advertencia
      return NextResponse.json({
        data: [],
        warning: 'Tabla vtex_accounts no encontrada o error en Supabase: ' + error.message,
      });
    }

    return NextResponse.json({ data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!checkAdmin(req)) {
      return NextResponse.json(
        { error: 'Prohibido: Solo los administradores pueden registrar o gestionar cuentas VTEX.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { company_name, account_name, environment, app_key, app_token } = body;

    if (!company_name || !account_name || !app_key || !app_token) {
      return NextResponse.json({ error: 'Todos los campos son obligatorios.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('vtex_accounts')
      .insert([
        {
          company_name: company_name.trim(),
          account_name: account_name.trim().toLowerCase(),
          environment: (environment || 'vtexcommercestable').trim(),
          app_key: app_key.trim(),
          app_token: app_token.trim(),
          is_active: true,
        },
      ])
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!checkAdmin(req)) {
      return NextResponse.json(
        { error: 'Prohibido: Solo los administradores pueden eliminar cuentas VTEX.' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'ID de cuenta requerido' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('vtex_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
