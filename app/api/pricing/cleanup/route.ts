import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { supabaseAdmin } from '@/lib/supabase';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const accountId = formData.get('accountId') as string;
    const tablesRaw = formData.get('tables') as string;
    const isDryRun = formData.get('dryRun') === 'true';
    const file = formData.get('file') as File | null;

    if (!accountId) {
      return new Response(JSON.stringify({ error: 'Parámetro accountId es obligatorio.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Obtener credenciales de la cuenta
    const { data: account, error: accountError } = await supabaseAdmin
      .from('vtex_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: `Cuenta no encontrada: ${accountError?.message || 'ID inválido'}` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Si PYTHON_SERVICE_URL está presente (Vercel Services), delegar
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    if (pythonServiceUrl) {
      const outgoing = new FormData();
      outgoing.append('account', account.account_name);
      outgoing.append('app_key', account.app_key);
      outgoing.append('app_token', account.app_token);
      outgoing.append('environment', account.environment || 'vtexcommercestable');
      outgoing.append('tables', tablesRaw || '');
      outgoing.append('dry_run', isDryRun ? 'true' : 'false');
      if (file) {
        outgoing.append('file', file, file.name);
      }

      const serviceRes = await fetch(`${pythonServiceUrl.replace(/\/$/, '')}/pricing/cleanup`, {
        method: 'POST',
        body: outgoing,
      });

      if (!serviceRes.ok) {
        const errText = await serviceRes.text();
        return new Response(JSON.stringify({ error: `Error en microservicio Python: ${errText}` }), {
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

    // 3. Fallback Local: child_process.spawn
    let tempFilePath: string | null = null;
    if (file) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      tempFilePath = path.join(os.tmpdir(), `pricing_clean_${Date.now()}_${safeFileName}`);
      fs.writeFileSync(tempFilePath, buffer);
    }

    let pythonProcess: any = null;

    const stream = new ReadableStream({
      start(controller) {
        let isClosed = false;

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {}
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
          message: `Iniciando motor de limpieza de precios (${isDryRun ? 'DRY-RUN' : 'LIVE'}) en cuenta ${account.account_name}...`,
        });

        const pythonArgs = [
          runnerPath,
          '--entity', 'pricing_cleanup',
          '--account', account.account_name,
          '--app-key', account.app_key,
          '--app-token', account.app_token,
          '--environment', account.environment || 'vtexcommercestable',
        ];

        if (tablesRaw) {
          pythonArgs.push('--tables', tablesRaw);
        }

        if (tempFilePath) {
          pythonArgs.push('--file', tempFilePath);
        }

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
          if (tempFilePath && fs.existsSync(tempFilePath)) {
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
          sendEvent({
            type: 'error',
            message: `Error al iniciar proceso Python: ${err.message}`,
            meta: { error: String(err) },
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
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: `Error interno: ${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
