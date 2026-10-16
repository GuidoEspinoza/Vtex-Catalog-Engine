import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const filePath = path.join(
      process.cwd(),
      'public',
      'templates',
      'Planilla_de_eliminacion_de_precios_por_SKU.xlsx'
    );

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Plantilla no encontrada en el servidor' }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Planilla de eliminacion de precios por SKU.xlsx"',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: `Error al servir plantilla: ${err.message}` }, { status: 500 });
  }
}
