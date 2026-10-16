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

    const pricingUrl = `https://api.vtex.com/${account.account_name}/pricing/tables`;
    const res = await fetch(pricingUrl, {
      headers: {
        'X-VTEX-API-AppKey': account.app_key,
        'X-VTEX-API-AppToken': account.app_token,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `Error al consultar tablas de precios (${res.status}): ${errText}` },
        { status: res.status }
      );
    }

    const tables: string[] = await res.json();
    return NextResponse.json({
      tables: Array.isArray(tables) ? tables : [],
      accountName: account.account_name,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `Error interno al consultar tablas: ${error.message || error}` },
      { status: 500 }
    );
  }
}
