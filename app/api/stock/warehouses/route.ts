import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get('accountId');

    if (!accountId) {
      return NextResponse.json({ error: 'Parámetro accountId requerido.' }, { status: 400 });
    }

    const { data: account, error: accountError } = await supabaseAdmin
      .from('vtex_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    if (accountError || !account) {
      return NextResponse.json(
        { error: `Cuenta no encontrada: ${accountError?.message || 'ID inválido'}` },
        { status: 404 }
      );
    }

    const env = account.environment || 'vtexcommercestable';
    const logisticsUrl = `https://${account.account_name}.${env}.com.br/api/logistics/pvt/configuration/warehouses`;
    
    const res = await fetch(logisticsUrl, {
      headers: {
        'X-VTEX-API-AppKey': account.app_key,
        'X-VTEX-API-AppToken': account.app_token,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `Error al consultar almacenes de VTEX (${res.status}): ${errText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const warehouses = Array.isArray(data)
      ? data.map((w: any) => ({
          id: String(w.id || ''),
          name: String(w.name || w.id || ''),
        }))
      : [];

    return NextResponse.json({
      warehouses,
      accountName: account.account_name,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `Error interno al consultar almacenes: ${error.message || error}` },
      { status: 500 }
    );
  }
}
