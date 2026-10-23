import os
import sys
import time
import requests
import pandas as pd
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional, Set, Tuple
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def identify_duplicates(files: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Agrupa los archivos por su nombre/clave y separa la copia a conservar
    de las copias redundantes a eliminar:
    - Conserva prioritariamente si IsMain == True.
    - Conserva el Id más antiguo (menor Id numérico).
    """
    if not files or len(files) <= 1:
        return files, []

    grouped = defaultdict(list)
    for f in files:
        raw_name = (f.get("Name") or "").strip()
        label = (f.get("Label") or "").strip()
        archive_id = f.get("ArchiveId")
        
        # Agrupación por nombre o por archiveId
        if raw_name:
            key = raw_name.lower()
        elif archive_id:
            key = f"archive_{archive_id}"
        elif label:
            key = f"label_{label.lower()}"
        else:
            key = f"id_{f.get('Id')}"
            
        grouped[key].append(f)

    kept = []
    to_delete = []

    for key, group in grouped.items():
        if len(group) == 1:
            kept.append(group[0])
        else:
            sorted_group = sorted(
                group,
                key=lambda x: (not x.get("IsMain", False), x.get("Id", 999999999)),
            )
            kept.append(sorted_group[0])
            to_delete.extend(sorted_group[1:])

    return kept, to_delete

def process_images_cleanup(
    client: VtexClient,
    file_path: Optional[str] = None,
    skus_raw: Optional[str] = None,
    delete_all: bool = False,
    dry_run: bool = False,
    max_workers: int = 8
):
    """
    Gestión y limpieza de imágenes en SKUs de VTEX.
    - delete_all=False (Modo Duplicados): Detecta y elimina imágenes duplicadas por SKU conservando la original.
    - delete_all=True (Modo Purga Total): Elimina TODAS las imágenes de los SKUs especificados.
    - file_path: Archivo XLSX, CSV o TXT con los SKUs a procesar.
    - skus_raw: SKUs separados por coma (ej. 1024, 1852, 2300).
    - dry_run: Simulación sin alterar datos reales en VTEX.
    - max_workers: Concurrencia para consultas y eliminaciones en VTEX.
    """
    account = client.account
    mode_label = "SIMULACIÓN (DRY-RUN)" if dry_run else "PRODUCCIÓN"
    action_mode = "PURGA TOTAL (Eliminar todas las imágenes)" if delete_all else "LIMPIEZA DE DUPLICADOS (Conservar original)"

    emit_log("info", f"=== Limpieza de Imágenes VTEX ({mode_label}) ===")
    emit_log("info", f"Cuenta activa: {account}")
    emit_log("info", f"Modo de operación: {action_mode}")
    if delete_all:
        emit_log("warning", "🚨 ATENCIÓN: Modo Purga Total activo. Se eliminarán TODAS las imágenes de los SKUs procesados.")

    target_skus: List[str] = []

    # 1. Determinar SKUs a procesar
    # 1.1 Desde lista manual (skus_raw)
    if skus_raw and skus_raw.strip():
        emit_log("info", f"Procesando SKUs desde entrada manual...")
        items = [s.strip() for s in skus_raw.replace(';', ',').replace('\n', ',').split(',') if s.strip()]
        seen = set()
        for it in items:
            try:
                s_id = str(int(float(it)))
            except Exception:
                s_id = str(it).strip()
            if s_id and s_id not in seen:
                seen.add(s_id)
                target_skus.append(s_id)
        emit_log("info", f"Se identificaron {len(target_skus)} SKUs únicos desde la entrada manual.")

    # 1.2 Desde archivo XLSX, CSV o TXT
    elif file_path and os.path.exists(file_path):
        emit_log("info", f"Cargando SKUs desde archivo: {os.path.basename(file_path)}")
        ext = os.path.splitext(file_path)[1].lower()
        seen = set()
        try:
            if ext == '.txt':
                with open(file_path, 'r', encoding='utf-8') as f:
                    lines = [line.strip() for line in f if line.strip()]
                for l in lines:
                    if l.isdigit() and l not in seen:
                        seen.add(l)
                        target_skus.append(l)
            else:
                df = pd.read_excel(file_path) if ext in ['.xlsx', '.xls'] else pd.read_csv(file_path)
                df.columns = [str(c).strip().lower() for c in df.columns]

                # Detectar columna de SKU ID
                candidate_names = ['skuid', 'sku_id', 'sku', 'stockkeepingunitid', 'id_sku', 'id', 'sku id', 'id sku', 'item']
                target_col = None
                for col in df.columns:
                    col_clean = str(col).strip().lower().replace(" ", "").replace("_", "")
                    if col_clean in candidate_names or 'sku' in col_clean:
                        target_col = col
                        break

                if target_col is None:
                    target_col = df.columns[0]
                    emit_log("warning", f"No se detectó columna 'sku', usando primera columna: '{target_col}'")

                for val in df[target_col].dropna():
                    try:
                        s_id = str(int(float(str(val).strip())))
                    except Exception:
                        s_id = str(val).strip()
                    if s_id and s_id.lower() != 'nan' and s_id not in seen:
                        seen.add(s_id)
                        target_skus.append(s_id)

            emit_log("info", f"Se cargaron {len(target_skus)} SKUs únicos a procesar desde el archivo.")
        except Exception as e:
            emit_log("error", f"Error al procesar archivo de SKUs: {str(e)}")
            return

    # 1.3 Modo Automático: Escanear catálogo completo de SKUs en VTEX
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
                    emit_log("info", f"Página {page}: {len(data)} SKUs (Acumulado: {len(all_skus)})")
                    if len(data) < page_size:
                        break
                    page += 1
                else:
                    emit_log("warning", f"Página {page} de SKUs respondió con status {r.status_code}")
                    break
            except Exception as e:
                emit_log("error", f"Error paginando SKUs de catálogo: {str(e)}")
                break

        target_skus = all_skus
        emit_log("info", f"Total de SKUs encontrados en catálogo: {len(target_skus)}.")

    if not target_skus:
        emit_log("warning", "No se encontraron SKUs para procesar.")
        emit_summary(0, 0, 0, 0, 0, dry_run)
        return

    total_skus = len(target_skus)
    emit_log("info", f"Escaneando imágenes asociadas a {total_skus} SKUs con {max_workers} workers...")

    # 2. Consultar archivos/imágenes por SKU de manera concurrente
    sku_files_map: Dict[str, List[Dict[str, Any]]] = {}
    completed_scans = 0

    def fetch_sku_images(sku_id: str):
        endpoint = f"/api/catalog/pvt/stockkeepingunit/{sku_id}/file"
        for attempt in range(3):
            try:
                res = client.get(endpoint)
                if res.status_code == 200:
                    data = res.json()
                    return sku_id, data if isinstance(data, list) else []
                elif res.status_code == 404:
                    return sku_id, []
                elif res.status_code == 429:
                    time.sleep(1 + attempt)
                    continue
                else:
                    return sku_id, []
            except Exception:
                time.sleep(0.5)
        return sku_id, []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_sku = {executor.submit(fetch_sku_images, s): s for s in target_skus}
        for future in as_completed(future_to_sku):
            completed_scans += 1
            s_id, files = future.result()
            sku_files_map[s_id] = files
            if completed_scans % 50 == 0 or completed_scans == total_skus:
                emit_progress(completed_scans, total_skus, f"Escaneando imágenes ({completed_scans}/{total_skus} SKUs)")

    # 3. Analizar imágenes según el modo (Duplicados vs Purga Total)
    total_images_found = 0
    skus_with_images = 0
    skus_with_duplicates = 0
    all_deletion_tasks: List[Tuple[str, int, str]] = []  # (sku_id, file_id, file_name)
    total_kept_count = 0

    for s_id in target_skus:
        files = sku_files_map.get(s_id, [])
        file_count = len(files)
        total_images_found += file_count

        if file_count > 0:
            skus_with_images += 1

        if delete_all:
            # Purga total: 0 conservadas, todas marcadas para eliminar
            for f in files:
                f_id = f.get("Id")
                if f_id:
                    all_deletion_tasks.append((s_id, f_id, f.get("Name", "sin_nombre")))
        else:
            kept, to_delete = identify_duplicates(files)
            total_kept_count += len(kept)
            if len(to_delete) > 0:
                skus_with_duplicates += 1
                for f in to_delete:
                    f_id = f.get("Id")
                    if f_id:
                        all_deletion_tasks.append((s_id, f_id, f.get("Name", "sin_nombre")))
            else:
                pass

    total_deletions = len(all_deletion_tasks)

    emit_log("info", "================ RESULTADOS DEL DIAGNÓSTICO ================")
    emit_log("info", f"Total SKUs analizados:                      {total_skus}")
    emit_log("info", f"SKUs que contienen imágenes:                {skus_with_images}")
    emit_log("info", f"Total de imágenes encontradas en catálogo:  {total_images_found}")
    if delete_all:
        emit_log("warning", f"🚨 Imágenes marcadas para PURGA TOTAL:      {total_deletions}")
        emit_log("info", f"Imágenes que se conservarán:                0")
    else:
        emit_log("info", f"Imágenes únicas legítimas a conservar:      {total_kept_count}")
        emit_log("info", f"SKUs con imágenes duplicadas:               {skus_with_duplicates}")
        emit_log("info", f"Imágenes duplicadas a eliminar:             {total_deletions}")
    emit_log("info", "============================================================")

    if total_deletions == 0:
        msg = "No se encontraron imágenes en los SKUs procesados." if delete_all else "✨ No se detectaron imágenes duplicadas en los SKUs analizados."
        emit_log("success", msg)
        emit_summary(total_images_found, 0, 0, 0, total_images_found, dry_run)
        return

    # 4. Ejecución (Dry-Run vs Real)
    deleted_count = 0
    error_count = 0

    if dry_run:
        emit_log("info", f"Iniciando reporte detallado de simulación ({total_deletions} imágenes marcadas)...")
        sample_limit = min(total_deletions, 100)
        for idx in range(sample_limit):
            s_id, f_id, f_name = all_deletion_tasks[idx]
            action_desc = "Purga Total" if delete_all else "Duplicado"
            desc = f"SKU {s_id} | Archivo ID {f_id} ('{f_name}')"
            emit_progress(idx + 1, total_deletions, desc, f"-> [DRY-RUN] Marcado para eliminar ({action_desc})")
            if (idx + 1) % 20 == 0:
                time.sleep(0.01)

        if total_deletions > sample_limit:
            remaining = total_deletions - sample_limit
            emit_log("info", f"... y {remaining} imágenes adicionales marcadas para eliminación.")

        deleted_count = total_deletions
        emit_summary(total_images_found, 0, deleted_count, 0, total_kept_count, dry_run=True)
        emit_log("success", f"Simulación finalizada. {total_deletions} imágenes quedarían eliminadas al ejecutar en producción.")
        return

    # Ejecución real (Live)
    action_str = "purga total" if delete_all else "duplicados"
    emit_log("info", f"🗑️ Eliminando {total_deletions} imágenes ({action_str}) en VTEX con {max_workers} workers...")

    def delete_image_worker(task: Tuple[str, int, str]):
        s_id, f_id, f_name = task
        desc = f"SKU {s_id} | Archivo {f_id} ('{f_name}')"
        endpoint = f"/api/catalog/pvt/stockkeepingunit/{s_id}/file/{f_id}"

        for attempt in range(3):
            try:
                res = client.delete(endpoint)
                if res.status_code in [200, 204]:
                    return "ok", desc, "✅ Imagen eliminada con éxito"
                elif res.status_code == 404:
                    return "not_found", desc, "ℹ️ Imagen ya no existe (404)"
                elif res.status_code == 429:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                else:
                    return "error", desc, f"Fallo ({res.status_code}): {res.text[:80]}"
            except Exception as e:
                if attempt == 2:
                    return "error", desc, f"Error de red: {str(e)}"
                time.sleep(1)
        return "error", desc, "Timeout tras 3 reintentos"

    completed_deletions = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_del = {executor.submit(delete_image_worker, t): t for t in all_deletion_tasks}
        for future in as_completed(future_to_del):
            completed_deletions += 1
            status, desc, msg = future.result()
            if status in ["ok", "not_found"]:
                deleted_count += 1
                emit_progress(completed_deletions, total_deletions, desc, f"-> {msg}")
            else:
                error_count += 1
                emit_log("error", f"{desc} -> {msg}")

    emit_summary(total_images_found, 0, deleted_count, error_count, total_kept_count, dry_run=False)
    emit_log("success", f"Limpieza de imágenes completada ({mode_label}). {deleted_count} eliminadas, {error_count} errores.")
