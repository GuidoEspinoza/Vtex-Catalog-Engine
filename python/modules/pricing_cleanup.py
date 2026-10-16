import os
import sys
import time
import requests
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def process_pricing_cleanup(
    client: VtexClient,
    target_tables: List[str],
    file_path: Optional[str] = None,
    dry_run: bool = False,
    max_workers: int = 8
):
    """
    Elimina precios fijos de SKUs asociados a tablas de precios específicas en VTEX.
    Soporta modo masivo por escaneo de catálogo y modo acotado por archivo Excel.
    """
    account = client.account
    pricing_base_url = f"https://api.vtex.com/{account}/pricing/prices"

    pricing_headers = {
        "X-VTEX-API-AppKey": client.app_key,
        "X-VTEX-API-AppToken": client.app_token,
        "Accept": "application/json",
        "Content-Type": "application/json"
    }

    mode_label = "SIMULACIÓN (DRY-RUN)" if dry_run else "PRODUCCIÓN"
    emit_log("info", f"=== Limpieza de Listas de Precios VTEX ({mode_label}) ===")
    emit_log("info", f"Cuenta activa: {account} | Tablas objetivo: {target_tables}")

    if not target_tables and not file_path:
        emit_log("error", "No se especificaron tablas de precios para limpiar.")
        return

    # Normalizar tablas objetivo en minúsculas y conjunto
    target_tables_set = {str(t).strip().lower() for t in target_tables if str(t).strip()}

    sku_table_pairs: List[Dict[str, str]] = []

    # 1. Modo por Excel (si se proporcionó archivo)
    if file_path and os.path.exists(file_path):
        emit_log("info", f"Cargando pares SKU-Tabla desde archivo: {os.path.basename(file_path)}")
        try:
            df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
            df.columns = [str(c).strip().lower() for c in df.columns]

            sku_col = next((c for c in df.columns if 'sku' in c or 'item' in c), None)
            table_col = next((c for c in df.columns if 'tabla' in c or 'table' in c or 'lista' in c or 'policy' in c), None)

            if not sku_col:
                emit_log("error", f"No se encontró la columna de SKU ID en el archivo. Columnas: {list(df.columns)}")
                return

            for _, row in df.iterrows():
                raw_sku = row[sku_col]
                if pd.isna(raw_sku):
                    continue
                try:
                    s_id = str(int(float(raw_sku)))
                except Exception:
                    s_id = str(raw_sku).strip()

                t_id = str(row[table_col]).strip() if table_col and pd.notna(row[table_col]) else None

                if t_id:
                    # Si la fila tiene tabla específica, chequear si está en las seleccionadas (o agregarla)
                    if not target_tables_set or t_id.lower() in target_tables_set:
                        sku_table_pairs.append({"sku_id": s_id, "table_id": t_id})
                else:
                    # Si no especifica tabla en la fila, aplicar a todas las tablas objetivo
                    for t in target_tables_set:
                        sku_table_pairs.append({"sku_id": s_id, "table_id": t})

            emit_log("info", f"Se cargaron {len(sku_table_pairs)} pares SKU-Tabla desde la planilla.")
        except Exception as e:
            emit_log("error", f"Error al leer planilla de precios: {str(e)}")
            return

    # 2. Modo Automático por Catálogo: Obtener todos los SKUs de la tienda
    else:
        emit_log("info", "Consultando catálogo completo de SKUs en VTEX...")
        all_skus = []
        page = 1
        page_size = 1000

        while True:
            url = f"/api/catalog_system/pvt/sku/stockkeepingunitids?page={page}&pagesize={page_size}"
            try:
                r = client.get(url)
                if r.status_code == 200:
                    data = r.json()
                    if not data:
                        break
                    all_skus.extend(data)
                    if len(data) < page_size:
                        break
                    page += 1
                else:
                    emit_log("warning", f"Página {page} de SKUs respondió con status {r.status_code}")
                    break
            except Exception as e:
                emit_log("error", f"Error paginando SKUs de catálogo: {str(e)}")
                break

        total_skus = len(all_skus)
        emit_log("info", f"Total de SKUs encontrados en catálogo: {total_skus}. Verificando precios en tablas seleccionadas...")

        if total_skus == 0:
            emit_log("warning", "No se encontraron SKUs en la cuenta para procesar.")
            return

        # Inspeccionar qué SKUs tienen precios fijos en las tablas objetivo
        emit_log("info", "Escaneando precios fijos mediante pool concurrente...")

        def inspect_sku(sku_id: int):
            sku_str = str(sku_id)
            url = f"{pricing_base_url}/{sku_str}"
            try:
                res = requests.get(url, headers=pricing_headers, timeout=10)
                if res.status_code == 200:
                    data = res.json()
                    fixed_prices = data.get("fixedPrices", [])
                    matched_tables = []
                    for fp in fixed_prices:
                        t_policy = str(fp.get("tradePolicyId", "")).strip()
                        if t_policy.lower() in target_tables_set:
                            val = fp.get("value")
                            matched_tables.append((t_policy, val))
                    return sku_str, matched_tables
            except Exception:
                pass
            return sku_str, []

        found_count = 0
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_sku = {executor.submit(inspect_sku, sku): sku for sku in all_skus}
            for idx, future in enumerate(as_completed(future_to_sku)):
                sku_str, matches = future.result()
                if matches:
                    for t_name, val in matches:
                        sku_table_pairs.append({"sku_id": sku_str, "table_id": t_name, "value": val})
                        found_count += 1
                if (idx + 1) % 250 == 0 or (idx + 1) == total_skus:
                    pct = round(((idx + 1) / total_skus) * 100, 1)
                    emit_log("info", f"Escaneados {idx + 1}/{total_skus} SKUs ({pct}%)... Precios fijos encontrados: {found_count}")

    total_operations = len(sku_table_pairs)
    emit_log("info", f"Total de precios fijos a procesar: {total_operations}")

    if total_operations == 0:
        emit_log("success", "No se encontraron precios fijos en las tablas seleccionadas. Catálogo ya limpio.")
        emit_summary(0, 0, 0, 0, 0, dry_run)
        return

    # 3. Ejecución de la Limpieza (Dry-Run o DELETE Real)
    deleted_count = 0
    error_count = 0

    session = requests.Session()
    session.headers.update(pricing_headers)

    for i, item in enumerate(sku_table_pairs):
        sku_id = item["sku_id"]
        table_id = item["table_id"]
        val_str = f" (${item.get('value')})" if "value" in item else ""
        desc = f"SKU {sku_id} -> Tabla '{table_id}'{val_str}"

        if dry_run:
            emit_progress(i + 1, total_operations, desc, "-> [DRY-RUN] Marcado para eliminación")
            deleted_count += 1
            time.sleep(0.01)
        else:
            del_url = f"{pricing_base_url}/{sku_id}/fixed/{table_id}"
            try:
                del_res = session.delete(del_url, timeout=10)
                if del_res.status_code in [200, 204]:
                    emit_progress(i + 1, total_operations, desc, "-> ✅ Eliminado exitosamente")
                    deleted_count += 1
                elif del_res.status_code == 404:
                    emit_progress(i + 1, total_operations, desc, "-> ℹ️ Ya no existía (404)")
                    deleted_count += 1
                else:
                    emit_log("error", f"Fallo al eliminar {desc} (Status {del_res.status_code}): {del_res.text[:100]}")
                    error_count += 1
            except Exception as e:
                emit_log("error", f"Error de red en {desc}: {str(e)}")
                error_count += 1

            time.sleep(0.05)

    emit_summary(total_operations, 0, deleted_count, error_count, 0, dry_run)
    emit_log("success", f"Operación de limpieza de precios completada ({mode_label}).")
