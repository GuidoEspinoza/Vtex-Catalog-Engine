#!/usr/bin/env python3
"""
Master CLI Entrypoint para el motor de catálogo VTEX.
Invocado desde Next.js child_process.spawn para procesamiento desacoplado y streaming SSE.
"""
import argparse
import sys
import os

# Asegurar que el path incluya la carpeta python actual
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

from core.vtex_client import VtexClient
from core.events import emit_log, emit_event
from modules.categories import process_categories
from modules.brands import process_brands
from modules.specifications import process_specifications
from modules.spec_values import process_spec_values
from modules.product_specs import process_product_specs
from modules.collections import process_collections

def main():
    parser = argparse.ArgumentParser(description="VTEX Catalog Engine Master Runner")
    parser.add_argument("--entity", required=True, choices=[
        "categories", "brands", "specifications", "spec_values", "product_specs", "collections"
    ])
    parser.add_argument("--account", required=True, help="Nombre de cuenta VTEX")
    parser.add_argument("--app-key", required=True, help="X-VTEX-API-AppKey")
    parser.add_argument("--app-token", required=True, help="X-VTEX-API-AppToken")
    parser.add_argument("--environment", default="vtexcommercestable", help="Ambiente VTEX")
    parser.add_argument("--file", required=True, help="Ruta al archivo XLSX o CSV")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Ejecutar en modo simulación sin mutar datos")

    args = parser.parse_args()

    mode_label = "SIMULACIÓN (DRY-RUN)" if args.dry_run else "CARGA EN PRODUCCIÓN"
    emit_log("info", f"=== VTEX Catalog Engine v1.0 ===")
    emit_log("info", f"Operación: {args.entity.upper()} | Modo: {mode_label}")
    emit_log("info", f"Cuenta: {args.account} ({args.environment})")

    # Inicializar cliente VTEX
    try:
        client = VtexClient(
            account=args.account,
            app_key=args.app_key,
            app_token=args.app_token,
            environment=args.environment
        )
    except Exception as e:
        emit_log("error", f"Fallo al instanciar cliente VTEX: {str(e)}")
        sys.exit(1)

    # Despachar al módulo correspondiente
    dispatch_table = {
        "categories": process_categories,
        "brands": process_brands,
        "specifications": process_specifications,
        "spec_values": process_spec_values,
        "product_specs": process_product_specs,
        "collections": process_collections
    }

    handler = dispatch_table.get(args.entity)
    if not handler:
        emit_log("error", f"Entidad no reconocida: {args.entity}")
        sys.exit(1)

    try:
        handler(client=client, file_path=args.file, dry_run=args.dry_run)
        emit_log("success", f"Completado exitosamente: {args.entity} ({mode_label})")
        sys.exit(0)
    except Exception as e:
        emit_log("error", f"Excepción fatal no controlada: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
