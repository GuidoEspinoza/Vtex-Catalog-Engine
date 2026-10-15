import os
import time
import pandas as pd
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def get_or_create_subcollection(client: VtexClient, collection_id: int, dry_run: bool):
    get_url = f"/api/catalog/pvt/collection/{collection_id}/subcollection"
    try:
        res = client.get(get_url)
        if res.status_code == 200:
            subcols = res.json()
            if isinstance(subcols, list) and len(subcols) > 0:
                sub_id = subcols[0].get("Id") or subcols[0].get("id")
                if sub_id:
                    return int(sub_id)
    except Exception:
        pass

    if dry_run:
        return 88888

    post_url = "/api/catalog/pvt/subcollection"
    payload = {
        "CollectionId": collection_id,
        "Name": "Grupo Principal",
        "Type": "Inclusive",
        "PreSale": False,
        "Release": False
    }

    res = client.post(post_url, json=payload)
    if res.status_code in [200, 201]:
        data = res.json()
        sub_id = data.get("Id") or data.get("id")
        if sub_id:
            return int(sub_id)

    return None

def process_collections(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Crea o actualiza colecciones y asocia SKUs/Productos.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo archivo de colecciones: {os.path.basename(file_path)}")

    try:
        df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
        df.columns = [str(c).strip() for c in df.columns]

        name_col = next((c for c in df.columns if 'nombre' in c.lower() or 'collection' in c.lower() or 'name' in c.lower()), None)
        id_col = next((c for c in df.columns if 'id' in c.lower()), None)
        sku_col = next((c for c in df.columns if 'sku' in c.lower()), None)

        if not name_col:
            emit_log("error", f"Falta columna de nombre de colección. Columnas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de colecciones está vacío.")
            return

        emit_log("info", f"Procesando {total_rows} registros de colecciones para '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        for idx, row in df.iterrows():
            row_num = idx + 1
            col_name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""

            if not col_name or col_name.lower() == 'nan':
                skipped_count += 1
                continue

            col_id = None
            if id_col and pd.notna(row[id_col]):
                try:
                    col_id = int(float(row[id_col]))
                except (ValueError, TypeError):
                    col_id = None

            desc = f"Colección '{col_name}'" + (f" (ID: {col_id})" if col_id else "")

            if dry_run:
                emit_progress(row_num, total_rows, desc, "-> [DRY-RUN] Verificado para procesamiento")
                created_count += 1
            else:
                try:
                    payload = {
                        "Name": col_name,
                        "Searchable": True,
                        "Highlight": False
                    }
                    if col_id:
                        payload["Id"] = col_id

                    res = client.post("/api/catalog/pvt/collection", json=payload)
                    if res.status_code in [200, 201]:
                        res_data = res.json() if res.text else {}
                        actual_id = res_data.get("Id", col_id)
                        emit_progress(row_num, total_rows, desc, f"-> ✅ Creada (ID: {actual_id})")
                        created_count += 1
                    else:
                        emit_log("error", f"Fila #{row_num}: Error ({res.status_code}): {res.text[:120]}")
                        error_count += 1
                except Exception as e:
                    emit_log("error", f"Fila #{row_num}: Error: {str(e)}")
                    error_count += 1

            time.sleep(0.15)

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico en colecciones: {str(e)}")
