import os
import time
import pandas as pd
from typing import Optional
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def process_categories(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Procesa masivamente el árbol de categorías en VTEX.
    En modo dry_run=True, valida consistencia de IDs, jerarquía y existencia sin mutar datos.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo archivo de categorías: {os.path.basename(file_path)}")

    try:
        if file_path.endswith('.csv'):
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)

        df.columns = [str(c).strip() for c in df.columns]

        # Mapeo flexible de columnas
        id_col = next((c for c in df.columns if c.lower() in ['id de la categoría', 'id de la categoria', 'id', 'category id', 'categoryid']), None)
        name_col = next((c for c in df.columns if c.lower() in ['name', 'nombre', 'categoría', 'categoria']), None)
        keywords_col = next((c for c in df.columns if c.lower() in ['keywords', 'palabras clave', 'palabras sustitutas']), None)
        desc_col = next((c for c in df.columns if c.lower() in ['description', 'descripción', 'descripcion', 'meta description']), None)
        title_col = next((c for c in df.columns if c.lower() in ['title', 'título', 'titulo', 'meta title']), None)
        father_col = next((c for c in df.columns if c.lower() in ['fathercategoryid', 'father category id', 'id padre', 'fatherid']), None)
        global_col = next((c for c in df.columns if c.lower() in ['globalcategoryid', 'global category id', 'id global', 'globalcategoryid confirmado cliente']), None)
        storefront_col = next((c for c in df.columns if c.lower() in ['showinstorefront', 'mostrar en tienda']), None)
        active_col = next((c for c in df.columns if c.lower() in ['isactive', 'activo', 'active']), None)
        link_col = next((c for c in df.columns if c.lower() in ['activestorefrontlink', 'enlace activo']), None)
        brandfilter_col = next((c for c in df.columns if c.lower() in ['showbrandfilter', 'mostrar filtro marcas']), None)
        sku_mode_col = next((c for c in df.columns if 'stockkeepingunitselect' in c.lower()), None)

        if not name_col:
            emit_log("error", f"Falta la columna obligatoria 'Name' o 'Nombre'. Columnas detectadas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de categorías no contiene filas.")
            return

        emit_log("info", f"Iniciando procesamiento de {total_rows} filas para la cuenta '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        endpoint = "/api/catalog/pvt/category"

        for idx, row in df.iterrows():
            row_num = idx + 1
            cat_name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""

            if not cat_name or cat_name.lower() == 'nan':
                emit_log("warning", f"Fila #{row_num} omitida: Nombre de categoría vacío.")
                skipped_count += 1
                continue

            # ID de categoría
            cat_id = None
            if id_col and pd.notna(row[id_col]):
                try:
                    cat_id = int(float(row[id_col]))
                except (ValueError, TypeError):
                    cat_id = None

            # FatherCategoryId
            father_id = None
            if father_col and pd.notna(row[father_col]):
                try:
                    father_id = int(float(row[father_col]))
                except (ValueError, TypeError):
                    father_id = None

            # GlobalCategoryId
            global_id = None
            if global_col and pd.notna(row[global_col]):
                try:
                    global_id = int(float(row[global_col]))
                except (ValueError, TypeError):
                    global_id = None

            # SKU selection mode
            sku_mode = "SPECIFICATION"
            if sku_mode_col and pd.notna(row[sku_mode_col]):
                val_str = str(row[sku_mode_col]).strip().upper()
                if val_str in ["LIST", "FALSE", "0"]:
                    sku_mode = "LIST"

            payload = {
                "Name": cat_name,
                "Keywords": str(row[keywords_col]).strip() if keywords_col and pd.notna(row[keywords_col]) else "",
                "Title": str(row[title_col]).strip() if title_col and pd.notna(row[title_col]) else cat_name,
                "Description": str(row[desc_col]).strip() if desc_col and pd.notna(row[desc_col]) else cat_name,
                "FatherCategoryId": father_id,
                "GlobalCategoryId": global_id,
                "ShowInStoreFront": bool(row[storefront_col]) if storefront_col and pd.notna(row[storefront_col]) else True,
                "IsActive": bool(row[active_col]) if active_col and pd.notna(row[active_col]) else True,
                "ActiveStoreFrontLink": bool(row[link_col]) if link_col and pd.notna(row[link_col]) else True,
                "ShowBrandFilter": bool(row[brandfilter_col]) if brandfilter_col and pd.notna(row[brandfilter_col]) else True,
                "StockKeepingUnitSelectionMode": sku_mode,
                "Score": 1,
                "AdWordsRemarketingCode": None,
                "LomadeeCampaignCode": None
            }

            if cat_id is not None:
                payload["Id"] = cat_id

            cat_desc = f"'{cat_name}' (ID: {cat_id or 'Auto'})"

            if dry_run:
                # MODO SIMULACIÓN (DRY-RUN): Validaciones contra VTEX sin mutación
                valid = True
                
                # Validar existencia de categoría padre si está especificada
                if father_id:
                    check_father = client.get(f"/api/catalog/pvt/category/{father_id}")
                    if check_father.status_code not in [200, 204]:
                        emit_log("warning", f"Fila #{row_num}: Padre ID {father_id} no encontrado en VTEX (HTTP {check_father.status_code}).")
                        valid = False

                # Validar si ya existe la categoría
                if cat_id:
                    check_cat = client.get(f"/api/catalog/pvt/category/{cat_id}")
                    if check_cat.status_code in [200, 204]:
                        emit_progress(row_num, total_rows, cat_desc, "-> [DRY-RUN] Existente (se actualizará)")
                        updated_count += 1
                    else:
                        emit_progress(row_num, total_rows, cat_desc, "-> [DRY-RUN] No existe con ese ID (se creará)")
                        created_count += 1
                else:
                    emit_progress(row_num, total_rows, cat_desc, "-> [DRY-RUN] Válida para creación nueva")
                    created_count += 1

                if not valid:
                    error_count += 1
            else:
                # MODO PRODUCCIÓN: Carga real con POST / PUT
                try:
                    res = client.post(endpoint, json=payload)
                    if res.status_code in [200, 201, 204]:
                        res_data = res.json() if res.text else {}
                        res_id = res_data.get("Id", cat_id)
                        emit_progress(row_num, total_rows, cat_desc, f"-> ✅ Creada (VTEX ID: {res_id})")
                        created_count += 1
                    elif cat_id is not None:
                        # Intento con PUT si ya existía
                        res_put = client.put(f"{endpoint}/{cat_id}", json=payload)
                        if res_put.status_code in [200, 201, 204]:
                            emit_progress(row_num, total_rows, cat_desc, f"-> 🔄 Actualizada (ID: {cat_id})")
                            updated_count += 1
                        else:
                            emit_log("error", f"Fila #{row_num}: Error al actualizar ({res_put.status_code}): {res_put.text[:120]}")
                            error_count += 1
                    else:
                        emit_log("error", f"Fila #{row_num}: Error al crear ({res.status_code}): {res.text[:120]}")
                        error_count += 1
                except Exception as e:
                    emit_log("error", f"Fila #{row_num}: Excepción de red: {str(e)}")
                    error_count += 1

            time.sleep(0.15)  # Rate limit suave

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Fallo crítico leyendo planilla de categorías: {str(e)}")
