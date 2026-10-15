import os
import sys
import tempfile
import json
import asyncio
import pandas as pd
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Asegurar path de importación
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

app = FastAPI(
    title="VTEX Catalog Engine Python Service",
    description="Microservicio interno para procesamiento masivo y streaming de catálogo VTEX",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "vtex-catalog-engine-python",
        "version": "1.0.0"
    }

@app.post("/extract")
async def extract_excel_headers(file: UploadFile = File(...)):
    """Extrae encabezados y muestra de 3 filas de una planilla Excel o CSV."""
    temp_path = None
    try:
        suffix = os.path.splitext(file.filename or "")[1] or ".xlsx"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            temp_path = tmp.name

        df = pd.read_excel(temp_path) if temp_path.endswith(('.xlsx', '.xls')) else pd.read_csv(temp_path)
        headers = [str(c).strip() for c in df.columns]
        sample = df.head(3).fillna('').to_dict(orient='records')
        return {"headers": headers, "sample": sample}
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"headers": [], "sample": [], "error": str(e)}
        )
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

@app.post("/execute")
async def execute_catalog_script(
    file: UploadFile = File(...),
    entity: str = Form(...),
    account: str = Form(...),
    app_key: str = Form(...),
    app_token: str = Form(...),
    environment: str = Form("vtexcommercestable"),
    dry_run: bool = Form(False)
):
    """
    Ejecuta el runner de catálogo VTEX y transmite eventos en tiempo real mediante SSE.
    """
    suffix = os.path.splitext(file.filename or "")[1] or ".xlsx"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        temp_file_path = tmp.name

    runner_path = os.path.join(current_dir, "runner.py")

    async def event_generator():
        try:
            cmd = [
                sys.executable,
                runner_path,
                "--entity", entity,
                "--account", account,
                "--app-key", app_key,
                "--app-token", app_token,
                "--environment", environment,
                "--file", temp_file_path,
            ]
            if dry_run:
                cmd.append("--dry-run")

            init_event = {
                "timestamp": pd.Timestamp.now().strftime("%H:%M:%S"),
                "type": "info",
                "message": f"Iniciando motor Python: {entity.upper()} ({'DRY-RUN' if dry_run else 'PRODUCCIÓN'}) en {account}...",
                "meta": {}
            }
            yield f"data: {json.dumps(init_event)}\n\n"

            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=current_dir,
                env={**os.environ, "PYTHONUNBUFFERED": "1"}
            )

            # Transmitir stdout línea a línea
            while True:
                line_bytes = await process.stdout.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode(errors="replace").strip()
                if not line:
                    continue

                if line.startswith("__VTEX_EVENT__"):
                    try:
                        raw_json = line.replace("__VTEX_EVENT__", "").strip()
                        parsed = json.loads(raw_json)
                        yield f"data: {json.dumps(parsed)}\n\n"
                    except Exception:
                        yield f"data: {json.dumps({'type': 'stdout', 'message': line})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'stdout', 'message': line})}\n\n"

            # Esperar a que finalice
            stderr_bytes = await process.stderr.read()
            stderr_text = stderr_bytes.decode(errors="replace").strip()
            if stderr_text:
                yield f"data: {json.dumps({'type': 'stderr', 'message': stderr_text})}\n\n"

            await process.wait()
            exit_code = process.returncode

            final_event = {
                "timestamp": pd.Timestamp.now().strftime("%H:%M:%S"),
                "type": "complete" if exit_code == 0 else "failed",
                "message": f"Proceso concluido con código de salida: {exit_code}",
                "meta": {"exitCode": exit_code, "isDryRun": dry_run}
            }
            yield f"data: {json.dumps(final_event)}\n\n"

        except Exception as e:
            err_event = {
                "timestamp": pd.Timestamp.now().strftime("%H:%M:%S"),
                "type": "error",
                "message": f"Excepción fatal en servicio Python: {str(e)}",
                "meta": {"error": str(e)}
            }
            yield f"data: {json.dumps(err_event)}\n\n"
        finally:
            if os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except Exception:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )
