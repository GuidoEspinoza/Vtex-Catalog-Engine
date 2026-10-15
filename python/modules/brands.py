import os
import time
import pandas as pd
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def process_brands(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Procesa masivamente las marcas de catálogo en VTEX.
    Soporta modo simulación (dry-run) y carga en producción.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo archivo de marcas: {os.path.basename(file_path)}")

    try:
        if file_path.endswith('.csv'):
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)

        df.columns = [str(c).strip() for c in df.columns]

        name_col = next((c for c in df.columns if c.lower() in ['name', 'nombre', 'marca']), None)
        id_col = next((c for c in df.columns if c.lower() in ['id', 'brand id', 'id marca', 'brandid']), None)
        keywords_col = next((c for c in df.columns if c.lower() in ['palabras sustitutas', 'keywords', 'palabras clave']), None)
        text_col = next((c for c in df.columns if c.lower() in ['text', 'descripción', 'descripcion', 'meta description']), None)
        sitetitle_col = next((c for c in df.columns if c.lower() in ['sitetitle', 'site title', 'meta title', 'título sitio']), None)
        active_col = next((c for c in df.columns if c.lower() in ['active', 'activo']), None)

        if not name_col:
            emit_log("error", f"No se encontró la columna obligatoria 'Name' o 'Marca'. Columnas existentes: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de marcas está vacío.")
            return

        emit_log("info", f"Procesando {total_rows} marcas para la cuenta '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        endpoint = "/api/catalog/pvt/brand"

        for idx, row in df.iterrows():
            row_num = idx + 1
            brand_name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""

            if not brand_name or brand_name.lower() == 'nan':
                emit_log("warning", f"Fila #{row_num}: Marca omitida por nombre vacío.")
                skipped_count += 1
                continue

            brand_id = None
            if id_col and pd.notna(row[id_col]):
                try:
                    brand_id = int(float(row[id_col]))
                except (ValueError, TypeError):
                    brand_id = None

            is_active = True
            if active_col and pd.notna(row[active_col]):
                val_str = str(row[active_col]).strip().upper()
                is_active = val_str not in ["NO", "FALSE", "0"]

            payload = {
                "Name": brand_name,
                "Text": str(row[text_col]).strip() if text_col and pd.notna(row[text_col]) else brand_name,
                "Keywords": str(row[keywords_col]).strip() if keywords_col and pd.notna(row[keywords_col]) else "",
                "SiteTitle": str(row[sitetitle_col]).strip() if sitetitle_col and pd.notna(row[sitetitle_col]) else brand_name,
                "Active": is_active,
                "Menu": True,
                "Score": 1
            }

            if brand_id is not None:
                payload["Id"] = brand_id

            brand_desc = f"'{brand_name}'" + (f" (ID: {brand_id})" if brand_id else "")

            if dry_run:
                # MODO SIMULACIÓN: Chequear si existe por ID o por endpoint de marca
                if brand_id:
                    check_brand = client.get(f"{endpoint}/{brand_id}")
                    if check_brand.status_code in [200, 204]:
                        emit_progress(row_num, total_rows, brand_desc, "-> [DRY-RUN] Existente (se actualizará)")
                        updated_count += 1
                    else:
                        emit_progress(row_num, total_rows, brand_desc, "-> [DRY-RUN] No existe con ese ID (se creará)")
                        created_count += 1
                else:
                    emit_progress(row_num, total_rows, brand_desc, "-> [DRY-RUN] Válida para creación nueva")
                    created_count += 1
            else:
                # MODO PRODUCCIÓN
                try:
                    res = client.post(endpoint, json=payload)
                    if res.status_code in [200, 201, 204]:
                        res_data = res.json() if res.text else {}
                        res_id = res_data.get("Id", brand_id)
                        emit_progress(row_num, total_rows, brand_desc, f"-> ✅ Creada (VTEX ID: {res_id})")
                        created_count += 1
                    elif brand_id is not None:
                        res_put = client.put(f"{endpoint}/{brand_id}", json=payload)
                        if res_put.status_code in [200, 201, 204]:
                            emit_progress(row_num, total_rows, brand_desc, f"-> 🔄 Actualizada (ID: {brand_id})")
                            updated_count += 1
                        else:
                            emit_log("error", f"Fila #{row_num}: Error al actualizar marca ({res_put.status_code}): {res_put.text[:120]}")
                            error_count += 1
                    else:
                        emit_log("error", f"Fila #{row_num}: Error al crear marca ({res.status_code}): {res.text[:120]}")
                        error_count += 1
                except Exception as e:
                    emit_log("error", f"Fila #{row_num}: Error de conexión: {str(e)}")
                    error_count += 1

            time.sleep(0.15)

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico leyendo marcas: {str(e)}")
