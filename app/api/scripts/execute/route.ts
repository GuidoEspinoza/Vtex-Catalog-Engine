import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { supabaseAdmin } from '@/lib/supabase';


export const maxDuration = 300; // Permitir hasta 5 minutos de streaming en Vercel Pro/Services

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const entity = formData.get('entity') as string;
    const accountId = formData.get('accountId') as string;
    const isDryRun = formData.get('dryRun') === 'true';

    const ALLOWED_ENTITIES = ['categories', 'brands', 'specifications', 'spec_values', 'product_specs', 'collections'] as const;
    const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB
    const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

    if (!file || !entity || !accountId) {
      return new Response(JSON.stringify({ error: 'Parámetros incompletos (file, entity, accountId).' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!ALLOWED_ENTITIES.includes(entity as any)) {
      return new Response(JSON.stringify({ error: `Entidad no permitida: '${entity}'.` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'El archivo excede el límite máximo permitido de 30MB.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const fileExt = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(fileExt)) {
      return new Response(JSON.stringify({ error: `Formato de archivo '${fileExt}' no permitido. Usa .xlsx, .xls o .csv.` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Obtener credenciales de la cuenta desde Supabase
    const { data: account, error: accountError } = await supabaseAdmin
      .from('vtex_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: `Cuenta VTEX no encontrada en Supabase: ${accountError?.message || 'ID inexistente'}` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Si PYTHON_SERVICE_URL está disponible (Vercel Services), delegar al microservicio Python
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    if (pythonServiceUrl) {
      const outgoing = new FormData();
      outgoing.append('file', file, file.name);
      outgoing.append('entity', entity);
      outgoing.append('account', account.account_name);
      outgoing.append('app_key', account.app_key);
      outgoing.append('app_token', account.app_token);
      outgoing.append('environment', account.environment || 'vtexcommercestable');
      outgoing.append('dry_run', isDryRun ? 'true' : 'false');

      const serviceRes = await fetch(`${pythonServiceUrl.replace(/\/$/, '')}/execute`, {
        method: 'POST',
        body: outgoing,
      });

      if (!serviceRes.ok) {
        const errText = await serviceRes.text();
        return new Response(JSON.stringify({ error: `Fallo en microservicio Python (${serviceRes.status}): ${errText}` }), {
          status: serviceRes.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(serviceRes.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // 3. Fallback Local (Desarrollo): Guardar archivo temporal y ejecutar con child_process.spawn
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const tempDir = os.tmpdir();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempFilePath = path.join(tempDir, `vtex_${Date.now()}_${safeFileName}`);
    fs.writeFileSync(tempFilePath, buffer);

    // 4. Crear ReadableStream para SSE
    let pythonProcess: any = null;

    const stream = new ReadableStream({
      start(controller) {
        let isClosed = false;

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // ya cerrado por el receptor
            }
          }
        };

        const sendEvent = (data: object) => {
          if (isClosed) return;
          try {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            isClosed = true;
            if (pythonProcess && !pythonProcess.killed) {
              try {
                pythonProcess.kill();
              } catch {}
            }
          }
        };

        const runnerPath = path.join(process.cwd(), 'python', 'runner.py');

        sendEvent({
          type: 'info',
          message: `Iniciando motor Python: ${entity.toUpperCase()} (${isDryRun ? 'DRY-RUN' : 'LIVE'}) en cuenta ${account.account_name}...`,
        });

        const pythonArgs = [
          runnerPath,
          '--entity', entity,
          '--account', account.account_name,
          '--app-key', account.app_key,
          '--app-token', account.app_token,
          '--environment', account.environment || 'vtexcommercestable',
          '--file', tempFilePath,
        ];

        if (isDryRun) {
          pythonArgs.push('--dry-run');
        }

        pythonProcess = spawn('python3', pythonArgs, {
          cwd: path.join(process.cwd(), 'python'),
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
          },
        });

        pythonProcess.stdout.on('data', (chunk: any) => {
          const raw = chunk.toString();
          const lines = raw.split('\n');

          for (const line of lines) {
            if (!line.trim()) continue;

            if (line.startsWith('__VTEX_EVENT__')) {
              try {
                const parsed = JSON.parse(line.replace('__VTEX_EVENT__', ''));
                sendEvent(parsed);
              } catch {
                sendEvent({ type: 'stdout', message: line });
              }
            } else {
              sendEvent({ type: 'stdout', message: line });
            }
          }
        });

        pythonProcess.stderr.on('data', (chunk: any) => {
          const raw = chunk.toString();
          sendEvent({ type: 'stderr', message: raw });
        });

        pythonProcess.on('close', (code: any) => {
          // Limpiar archivo temporal
          if (fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
            } catch {}
          }

          sendEvent({
            type: code === 0 ? 'complete' : 'failed',
            message: `Proceso concluido con código de salida: ${code}`,
            meta: { exitCode: code, isDryRun },
          });

          safeClose();
        });

        pythonProcess.on('error', (err: any) => {
          if (fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
            } catch {}
          }

          sendEvent({
            type: 'error',
            message: `Fallo al lanzar el proceso Python: ${err.message}`,
          });

          safeClose();
        });
      },
      cancel() {
        if (pythonProcess && !pythonProcess.killed) {
          try {
            pythonProcess.kill();
          } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
