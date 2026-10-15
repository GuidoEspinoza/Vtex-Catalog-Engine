import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

// Modelos verificados en orden de prioridad
const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
] as const;

async function extractHeadersAndSample(filePath: string): Promise<{ headers: string[]; sample: unknown[] }> {
  const pythonScript = `
import pandas as pd, json, sys
f = sys.argv[1]
try:
    df = pd.read_excel(f) if f.endswith(('.xlsx', '.xls')) else pd.read_csv(f)
    headers = [str(c).strip() for c in df.columns]
    sample = df.head(3).fillna('').to_dict(orient='records')
    print(json.dumps({'headers': headers, 'sample': sample}))
except Exception as e:
    print(json.dumps({'headers': [], 'sample': [], 'error': str(e)}))
`;

  const { stdout } = await execFileAsync('python3', ['-c', pythonScript, filePath]);
  const data = JSON.parse(stdout.trim() || '{"headers":[],"sample":[]}');
  return { headers: data.headers || [], sample: data.sample || [] };
}

export async function POST(req: NextRequest) {
  let tempFilePath: string | null = null;

  try {
    const contentType = req.headers.get('content-type') || '';
    let entity = 'categories';
    let headers: string[] = [];
    let sampleRows: unknown[] = [];

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      entity = (formData.get('entity') as string) || 'categories';

      const ALLOWED_ENTITIES = ['categories', 'brands', 'specifications', 'spec_values', 'product_specs', 'collections'] as const;
      const MAX_FILE_SIZE = 30 * 1024 * 1024;
      const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

      if (!file) {
        return NextResponse.json({ error: 'No se recibió ningún archivo en la petición.' }, { status: 400 });
      }

      if (!ALLOWED_ENTITIES.includes(entity as any)) {
        return NextResponse.json({ error: `Entidad '${entity}' no permitida.` }, { status: 400 });
      }

      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json({ error: 'El archivo excede el tamaño máximo permitido (30MB).' }, { status: 400 });
      }

      const fileExt = path.extname(file.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(fileExt)) {
        return NextResponse.json({ error: `Extensión '${fileExt}' no permitida. Usa .xlsx, .xls o .csv.` }, { status: 400 });
      }

      // Guardar archivo temporal para que pandas extraiga con exactitud las columnas
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      tempFilePath = path.join(os.tmpdir(), `ai_eval_${Date.now()}_${safeName}`);
      fs.writeFileSync(tempFilePath, buffer);

      const extracted = await extractHeadersAndSample(tempFilePath);
      headers = extracted.headers;
      sampleRows = extracted.sample;
    } else {
      const body = await req.json();
      entity = body.entity || 'categories';
      headers = body.headers || [];
      sampleRows = body.sampleRows || [];
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GEMINI_API_KEY no está configurada en las variables de entorno.' },
        { status: 500 }
      );
    }

    const systemPrompt = `
Eres un Arquitecto de Software Senior y Especialista en la Catalog API de VTEX.
Tu objetivo es analizar los encabezados y filas de muestra de una planilla para la entidad: "${entity}".

Esquemas de referencia en VTEX:
- categories: Name (req), FatherCategoryId (opt), GlobalCategoryId (opt), Keywords, Title, Description, IsActive, ShowInStoreFront
- brands: Name (req), Text, Keywords, SiteTitle, Active
- specifications: Name (req), GroupName (req), FieldTypeId (1=Texto, 2=MultiTexto, 4=Fecha, 5=Combo, 6=Radio, 7=Checkbox, 8=Texto Indexado), CategoryId, IsStockKeepingUnit, IsRequired, IsFilter, IsActive
- spec_values: FieldId (req), Name/Valor (req), IsActive, Position
  * REGLA DE ORO VTEX: ÚNICAMENTE los campos de tipo Combo (FieldTypeId 5), Radio (FieldTypeId 6) y Checkbox (FieldTypeId 7) aceptan valores u opciones predefinidas en el catálogo.
  * Los campos de tipo Texto (FieldTypeId 1), Texto Multilínea (FieldTypeId 2) y Texto Indexado (FieldTypeId 8) NO aceptan opciones; VTEX los rechaza con el error 400 "This field does not accept specification values".
  * Si detectas nombres de atributos que parecen texto libre o notas que no son de opciones cerradas, incluye una advertencia técnica en "warnings" y "recommendations".
- product_specs: ProductId (req), FieldId (req), Valor (req)
- collections: Name (req), SkuId/ProductId (opt)

Evalúa la muestra provista y responde EXCLUSIVAMENTE con un objeto JSON válido con esta estructura:
{
  "valid": true/false,
  "confidenceScore": número entre 0 y 100,
  "detectedEntity": "${entity}",
  "headerMapping": {
    "nombre_columna_original": "campo_vtex_mapeado"
  },
  "missingRequired": ["lista de campos requeridos ausentes"],
  "warnings": ["advertencias semánticas o inconsistencias detectadas"],
  "recommendations": ["consejos de optimización previa al dry-run"]
}
`;

    const userPrompt = `
Encabezados detectados en la planilla:
${JSON.stringify(headers, null, 2)}

Muestra de datos (primeras filas):
${JSON.stringify(sampleRows, null, 2)}
`;

    // Reintentar con modelos soportados (gemini-3.8-flash y fallbacks)
    let lastError = '';
    let jsonRes: any = null;
    let selectedModel = '';

    for (const model of GEMINI_MODELS) {
      selectedModel = model;
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        }),
      });

      if (res.ok) {
        jsonRes = await res.json();
        break;
      } else {
        const errText = await res.text();
        lastError = `Modelo ${model} (${res.status}): ${errText}`;
        // Si es 404 (modelo no disponible) o 503 (sobrecarga temporal), prueba el siguiente modelo
        if (res.status === 404 || res.status === 503) {
          continue;
        } else {
          return NextResponse.json({ error: lastError }, { status: res.status });
        }
      }
    }

    if (!jsonRes) {
      return NextResponse.json({ error: `No se pudo conectar a los modelos de Gemini: ${lastError}` }, { status: 500 });
    }

    const rawContent = jsonRes.candidates?.[0]?.content?.parts?.[0]?.text;
    const analysis = JSON.parse(rawContent || '{}');

    return NextResponse.json({ success: true, model: selectedModel, analysis, headersExtracted: headers });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // noop
      }
    }
  }
}
