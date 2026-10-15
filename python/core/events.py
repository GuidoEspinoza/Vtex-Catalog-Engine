import json
import sys
from datetime import datetime
from typing import Dict, Any, Optional

def _now_str() -> str:
    return datetime.now().strftime("%H:%M:%S")

def emit_event(event_type: str, message: str, meta: Optional[Dict[str, Any]] = None):
    """
    Emite un payload JSON estructurado con prefijo estándar para que Next.js
    lo capture de stdout y lo retransmita mediante Server-Sent Events (SSE).
    """
    try:
        payload = {
            "timestamp": _now_str(),
            "type": event_type,
            "message": message,
            "meta": meta or {}
        }
        sys.stdout.write(f"__VTEX_EVENT__{json.dumps(payload)}\n")
        sys.stdout.flush()
    except (BrokenPipeError, IOError):
        # El receptor (stream de Next.js) cerró la tubería
        pass

def emit_log(level: str, message: str, meta: Optional[Dict[str, Any]] = None):
    """Atajo para logs generales (info, warning, error, success)."""
    emit_event(level, message, meta)

def emit_progress(current: int, total: int, entity_name: str = "", extra: str = ""):
    """Emite actualización de progreso con cálculo porcentual."""
    percentage = round((current / total) * 100, 1) if total > 0 else 0
    msg = f"[{current}/{total}] ({percentage}%) {entity_name} {extra}".strip()
    emit_event("progress", msg, {
        "current": current,
        "total": total,
        "percentage": percentage
    })

def emit_summary(processed: int, created: int, updated: int, errors: int, skipped: int, is_dry_run: bool):
    """Emite el resumen final de la corrida."""
    mode_str = "Simulación (Dry-Run)" if is_dry_run else "Carga en Producción"
    summary_data = {
        "mode": mode_str,
        "processed": processed,
        "created": created,
        "updated": updated,
        "errors": errors,
        "skipped": skipped,
        "success": errors == 0
    }
    emit_event("summary", f"Resumen de {mode_str}: {created} creados, {updated} actualizados, {errors} errores, {skipped} omitidos.", summary_data)
