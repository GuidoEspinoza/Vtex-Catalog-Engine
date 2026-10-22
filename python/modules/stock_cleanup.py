import os
import sys
import time
import requests
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional, Set, Tuple
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def process_stock_cleanup(
    client: VtexClient,
    target_warehouses: Optional[List[str]] = None,
    file_path: Optional[str] = None,
    dry_run: bool = False,
    max_workers: int = 8
):
    """
    Limpia y resetea el inventario en VTEX estableciendo la cantidad en 0 (y unlimitedQuantity=False).
    - target_warehouses: Lista de IDs de almacenes/bodegas a limpiar. Si no se indican, se consultan y limpian todos los almacenes activos de la cuenta.
    - file_path: Ruta a archivo XLSX o CSV con los SKUs a procesar. Si no se proporciona, escanea todo el catálogo de la tienda.
    - dry_run: Simulación sin alterar datos reales en VTEX.
    - max_workers: Hilos concurrentes para optimizar la velocidad en miles de SKUs.
    """
    account = client.account
    mode_label = "SIMULACIÓN (DRY-RUN)" if dry_run else "PRODUCCIÓN"

    emit_log("info", f"=== Limpieza de Inventario VTEX - Reseteo a 0 ({mode_label}) ===")
    emit_log("info", f"Cuenta activa: {account}")

    # 1. Resolver almacenes (Warehouses)
    active_warehouses: List[Dict[str, str]] = []
    try:
        w_res = client.get("/api/logistics/pvt/configuration/warehouses")
        if w_res.status_code == 200:
            raw_warehouses = w_res.json()
            if isinstance(raw_warehouses, list):
                active_warehouses = [
                    {"id": str(w.get("id")), "name": str(w.get("name") or w.get("id"))}
                    for w in raw_warehouses
                    if w.get("id")
                ]
    except Exception as e:
        emit_log("warning", f"No se pudo consultar lista de almacenes: {str(e)}")

    warehouse_dict = {w["id"]: w["name"] for w in active_warehouses}

    # Si se especificaron almacenes objetivo, filtrar; si no, usar todos los detectados
    selected_warehouse_ids: List[str] = []
    if target_warehouses and len(target_warehouses) > 0:
        selected_warehouse_ids = [str(w).strip() for w in target_warehouses if str(w).strip()]
    elif active_warehouses:
        selected_warehouse_ids = [w["id"] for w in active_warehouses]
    else:
        # Fallback si no hay almacenes detectados por API
        selected_warehouse_ids = ["1_1"]

    wh_names_display = [f"'{wid}' ({warehouse_dict.get(wid, wid)})" for wid in selected_warehouse_ids]
    emit_log("info", f"Almacenes objetivo ({len(selected_warehouse_ids)}): {', '.join(wh_names_display)}")

    # 2. Cargar pares (SKU, Almacén) a procesar
    sku_warehouse_pairs: List[Tuple[str, str]] = []

    # 2.1 Por archivo Excel o CSV
    if file_path and os.path.exists(file_path):
        emit_log("info", f"Cargando SKUs desde archivo: {os.path.basename(file_path)}")
        try:
            df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
            df.columns = [str(c).strip().lower() for c in df.columns]

            sku_col = next((c for c in df.columns if 'sku' in c or 'item' in c or 'id' in c), None)
            wh_col = next((c for c in df.columns if 'almacen' in c or 'almacén' in c or 'bodega' in c or 'warehouse' in c or 'deposito' in c or 'depósito' in c), None)

            if not sku_col:
                emit_log("error", f"No se encontró la columna de SKU ID en el archivo. Columnas: {list(df.columns)}")
                return

            seen_pairs: Set[Tuple[str, str]] = set()

            for _, row in df.iterrows():
                raw_sku = row[sku_col]
                if pd.isna(raw_sku):
                    continue
                try:
                    s_id = str(int(float(raw_sku)))
                except Exception:
                    s_id = str(raw_sku).strip()

                if not s_id or s_id.lower() == 'nan':
                    continue

                row_wh = str(row[wh_col]).strip() if wh_col and pd.notna(row[wh_col]) else None

                if row_wh:
                    pair = (s_id, row_wh)
                    if pair not in seen_pairs:
                        seen_pairs.add(pair)
                        sku_warehouse_pairs.append(pair)
                else:
                    for wid in selected_warehouse_ids:
                        pair = (s_id, wid)
                        if pair not in seen_pairs:
                            seen_pairs.add(pair)
                            sku_warehouse_pairs.append(pair)

            emit_log("info", f"Se extrajeron {len(sku_warehouse_pairs)} pares SKU-Almacén únicos desde la planilla.")
        except Exception as e:
            emit_log("error", f"Error al leer planilla de stock: {str(e)}")
            return

    # 2.2 Modo Automático: Escanear catálogo completo de SKUs
    else:
        emit_log("info", "Consultando catálogo completo de SKUs en VTEX...")
        all_skus: List[str] = []
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
                    all_skus.extend([str(item) for item in data])
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
        emit_log("info", f"Total de SKUs encontrados en catálogo: {total_skus}.")

        if total_skus == 0:
            emit_log("warning", "No se encontraron SKUs en la cuenta para procesar.")
            emit_summary(0, 0, 0, 0, 0, dry_run)
            return

        for s_id in all_skus:
            for wid in selected_warehouse_ids:
                sku_warehouse_pairs.append((s_id, wid))

    total_operations = len(sku_warehouse_pairs)
    emit_log("info", f"Total de operaciones de reseteo de stock a procesar: {total_operations}")

    if total_operations == 0:
        emit_log("warning", "No se definieron operaciones para procesar.")
        emit_summary(0, 0, 0, 0, 0, dry_run)
        return

    # 3. Ejecución de la Limpieza de Stock (Dry-Run vs Live)
    reset_count = 0
    error_count = 0

    if dry_run:
        for idx, (s_id, w_id) in enumerate(sku_warehouse_pairs):
            desc = f"SKU {s_id} -> Almacén '{w_id}'"
            emit_progress(idx + 1, total_operations, desc, "-> [DRY-RUN] Marcado para reseteo de stock a 0")
            reset_count += 1
            if (idx + 1) % 25 == 0:
                time.sleep(0.01)
    else:
        # Petición concurrente PUT a VTEX Logistics
        payload = {
            "unlimitedQuantity": False,
            "dateUtcOnBalanceSystem": None,
            "quantity": 0
        }

        def reset_stock_worker(pair: Tuple[str, str]):
            s_id, w_id = pair
            desc = f"SKU {s_id} -> Almacén '{w_id}'"
            endpoint = f"/api/logistics/pvt/inventory/skus/{s_id}/warehouses/{w_id}"

            for attempt in range(3):
                try:
                    res = client.put(endpoint, json=payload)
                    if res.status_code in [200, 204]:
                        return "ok", desc, "✅ Stock actualizado a 0"
                    elif res.status_code == 404:
                        return "not_found", desc, "ℹ️ SKU o almacén no existente (404)"
                    elif res.status_code == 429:
                        time.sleep(1 + attempt)
                        continue
                    else:
                        return "error", desc, f"Fallo ({res.status_code}): {res.text[:80]}"
                except Exception as e:
                    if attempt == 2:
                        return "error", desc, f"Error de red: {str(e)}"
                    time.sleep(0.5)
            return "error", desc, "Timeout tras reintentos"

        completed = 0
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_pair = {executor.submit(reset_stock_worker, p): p for p in sku_warehouse_pairs}
            for future in as_completed(future_to_pair):
                completed += 1
                status, desc, msg = future.result()
                if status in ["ok", "not_found"]:
                    reset_count += 1
                    emit_progress(completed, total_operations, desc, f"-> {msg}")
                else:
                    error_count += 1
                    emit_log("error", f"{desc} -> {msg}")

    emit_summary(total_operations, 0, reset_count, error_count, 0, dry_run)
    emit_log("success", f"Operación de reseteo de stock a 0 completada exitosamente ({mode_label}).")
