import os
import time
import pandas as pd
from typing import Dict, Any, Optional
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def normalize_text(text: str) -> str:
    import unicodedata
    if not text:
        return ""
    nfkd = unicodedata.normalize('NFKD', str(text).strip().lower())
    return ''.join([c for c in nfkd if not unicodedata.combining(c)])

def find_column(df_columns, candidates):
    cols_norm = {normalize_text(c): c for c in df_columns}
    # 1. Búsqueda exacta normalizada
    for cand in candidates:
        cand_norm = normalize_text(cand)
        if cand_norm in cols_norm:
            return cols_norm[cand_norm]
    # 2. Búsqueda por contención
    for cand in candidates:
        cand_norm = normalize_text(cand)
        for c_norm, original_c in cols_norm.items():
            if cand_norm in c_norm or c_norm in cand_norm:
                return original_c
    return None

def parse_bool(val, default=False):
    if pd.isna(val):
        return default
    val_str = normalize_text(val).upper()
    return val_str in ["SI", "YES", "TRUE", "1"]

def parse_sku_bool(val, default=False):
    if pd.isna(val):
        return default
    val_str = normalize_text(val).upper()
    if val_str in ["SKU"]:
        return True
    if val_str in ["PRODUCTO", "PRODUCT"]:
        return False
    return val_str in ["SI", "YES", "TRUE", "1"]

def map_field_type(val):
    """
    Mapeo de tipos de especificación según VTEX Catalog API:
    1: Texto (Texto libre)
    2: Texto Multilínea
    4: Fecha
    5: Combo (Desplegable con opciones predefinidas)
    6: Radio (Opciones únicas predefinidas)
    7: CheckBox (Múltiples opciones predefinidas)
    8: Texto Indexado (Texto libre indexado en búsqueda, NO admite opciones en /specificationvalue)
    9: Texto Indexado Multilínea
    """
    if pd.isna(val):
        return 1
    val_str = normalize_text(val).upper()
    if "CHECK" in val_str:
        return 7
    elif "RADIO" in val_str:
        return 6
    elif "COMBO" in val_str or "SELECT" in val_str:
        return 5
    elif "INDEX" in val_str:
        return 9 if "MULTI" in val_str else 8
    elif "MULTI" in val_str:
        return 2
    elif "FECHA" in val_str or "DATE" in val_str:
        return 4
    elif "TEXT" in val_str:
        return 1
    return 1

VTEX_FIELD_TYPE_NAMES = {
    1: "Texto",
    2: "Texto Multilínea",
    4: "Fecha",
    5: "Combo",
    6: "Radio",
    7: "CheckBox",
    8: "Texto Indexado",
    9: "Texto Indexado Multilínea"
}

def get_or_create_group(client: VtexClient, category_id: Optional[int], group_name: str, cache: dict, dry_run: bool):
    cat_payload = category_id if category_id and category_id > 0 else None
    cache_key = (cat_payload, group_name.strip().lower())
    
    if cache_key in cache:
        return cache[cache_key]

    # Consultar si ya existe
    if cat_payload:
        list_url = f"/api/catalog_system/pvt/specification/groupbycategory/{cat_payload}"
        try:
            res = client.get(list_url)
            if res.status_code == 200:
                groups = res.json()
                if isinstance(groups, list):
                    for g in groups:
                        g_name = (g.get("Name") or g.get("name") or "").strip().lower()
                        if g_name == group_name.strip().lower():
                            g_id = int(g.get("Id") or g.get("id"))
                            cache[cache_key] = g_id
                            return g_id
        except Exception:
            pass

    if dry_run:
        dummy_id = 99999
        cache[cache_key] = dummy_id
        return dummy_id

    # Crear grupo
    create_url = "/api/catalog/pvt/specificationgroup"
    payload = {"CategoryId": cat_payload, "Name": group_name.strip()}
    res = client.post(create_url, json=payload)
    if res.status_code in [200, 201]:
        data = res.json()
        new_id = int(data.get("Id") or data.get("id"))
        cache[cache_key] = new_id
        return new_id

    emit_log("error", f"Error al crear grupo '{group_name}' ({res.status_code}): {res.text[:120]}")
    return None

def get_existing_fields_for_category(client: VtexClient, category_id: Optional[int], cache: dict) -> Dict[str, dict]:
    """Obtiene campos existentes indexados por nombre en minúsculas."""
    cat_key = category_id if category_id and category_id > 0 else 0
    if cat_key in cache:
        return cache[cat_key]

    url = f"/api/catalog_system/pub/specification/field/listByCategoryId/{cat_key}" if cat_key > 0 else "/api/catalog_system/pub/specification/field/listTreeByCategoryId/0"
    fields_map = {}
    try:
        res = client.get(url)
        if res.status_code == 200:
            data = res.json()
            if isinstance(data, list):
                for f in data:
                    name_key = normalize_text(f.get("Name", ""))
                    if name_key:
                        fields_map[name_key] = f
    except Exception:
        pass

    cache[cat_key] = fields_map
    return fields_map

def process_specifications(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Crea grupos y campos de especificación en VTEX con soporte Dry-Run y validaciones semánticas previas.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo archivo de especificaciones: {os.path.basename(file_path)}")

    try:
        df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
        df.columns = [str(c).strip() for c in df.columns]

        cat_col = find_column(df.columns, [
            'id de la categoria', 'id de la categoría', 'id categoria', 'id categoría', 'id de categoria', 'categoryid', 'categoria'
        ])
        name_col = find_column(df.columns, ['nombre del atributo', 'nombre de atributo', 'name', 'nombre', 'campo', 'atributo'])
        group_col = find_column(df.columns, ['nombre del grupo', 'nombre de grupo', 'groupname', 'grupo'])
        field_type_col = find_column(df.columns, ['tipo de campo', 'tipo campo', 'fieldtypeid', 'tipo'])
        description_col = find_column(df.columns, ['descripcion', 'descripción', 'description'])
        stockkeeping_col = find_column(df.columns, ['tipo de atributo', 'tipo atributo', 'isstockkeepingunit', 'es sku', 'sku'])
        required_col = find_column(df.columns, ['es obligatorio', 'obligatorio', 'isrequired', 'requerido'])
        filter_col = find_column(df.columns, ['es filtro', 'filtro', 'isfilter'])
        active_col = find_column(df.columns, ['activo', 'isactive'])

        if not name_col or not group_col:
            emit_log("error", f"Faltan columnas requeridas ('Nombre del Atributo' y 'Nombre del Grupo'). Detectadas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de especificaciones está vacío.")
            return

        emit_log("info", f"Procesando {total_rows} especificaciones para '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        group_cache = {}
        category_fields_cache = {}
        field_detail_cache = {}
        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        for idx, row in df.iterrows():
            row_num = idx + 1
            field_name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""
            group_name = str(row[group_col]).strip() if pd.notna(row[group_col]) else ""

            if not field_name or not group_name:
                emit_log("warning", f"Fila #{row_num}: Omitida por nombre o grupo vacío.")
                skipped_count += 1
                continue

            cat_id = None
            if cat_col and pd.notna(row[cat_col]):
                try:
                    parsed_cat = int(float(row[cat_col]))
                    cat_id = parsed_cat if parsed_cat > 0 else None
                except (ValueError, TypeError):
                    cat_id = None

            group_id = get_or_create_group(client, cat_id, group_name, group_cache, dry_run)
            if not group_id and not dry_run:
                error_count += 1
                continue

            field_type = map_field_type(row[field_type_col]) if field_type_col else 1
            field_type_name = VTEX_FIELD_TYPE_NAMES.get(field_type, f"Tipo {field_type}")
            is_sku = parse_sku_bool(row[stockkeeping_col]) if stockkeeping_col else False
            is_required = parse_bool(row[required_col]) if required_col else False
            is_filter = parse_bool(row[filter_col]) if filter_col else False
            is_active = parse_bool(row[active_col], default=True) if active_col else True

            field_desc = f"'{field_name}' [Cat: {cat_id or 0}, Grupo: {group_name}]"

            # Verificar si el campo ya existe en esta categoría
            existing_fields = get_existing_fields_for_category(client, cat_id, category_fields_cache)
            norm_name = normalize_text(field_name)
            existing_field = existing_fields.get(norm_name)

            if existing_field:
                existing_id = existing_field.get("FieldId")
                # Obtener detalle completo si no lo tenemos
                if existing_id not in field_detail_cache:
                    det_res = client.get(f"/api/catalog_system/pub/specification/fieldGet/{existing_id}")
                    if det_res.status_code == 200:
                        field_detail_cache[existing_id] = det_res.json()
                    else:
                        field_detail_cache[existing_id] = existing_field

                full_det = field_detail_cache.get(existing_id, {})
                existing_type_id = full_det.get("FieldTypeId")
                existing_type_name = VTEX_FIELD_TYPE_NAMES.get(existing_type_id, full_det.get("FieldTypeName", "Desconocido"))

                if existing_type_id == field_type:
                    emit_progress(row_num, total_rows, field_desc, f"-> ℹ️ Ya existe (FieldId: {existing_id}, Tipo: {existing_type_name})")
                    updated_count += 1
                else:
                    emit_log(
                        "warning",
                        f"Fila #{row_num}: El campo '{field_name}' ya existe con FieldId {existing_id} y tipo '{existing_type_name}' ({existing_type_id}), "
                        f"pero la planilla solicita '{field_type_name}' ({field_type}). VTEX no permite cambiar el tipo de un campo existente por API. "
                        f"Debe recrearse o editarse en VTEX Admin."
                    )
                    skipped_count += 1
                time.sleep(0.05)
                continue

            payload = {
                "CategoryId": cat_id,
                "FieldGroupId": group_id,
                "Name": field_name,
                "Description": str(row[description_col]).strip() if description_col and pd.notna(row[description_col]) else field_name,
                "FieldTypeId": field_type,
                "IsStockKeepingUnit": is_sku,
                "IsRequired": is_required,
                "IsFilter": is_filter,
                "IsActive": is_active,
                "IsTopMenuLinkActive": False,
                "IsSideMenuLinkActive": False
            }

            if dry_run:
                emit_progress(row_num, total_rows, field_desc, f"-> [DRY-RUN] Válido para creación (Tipo: {field_type_name}, SKU: {is_sku})")
                created_count += 1
            else:
                endpoint = "/api/catalog_system/pvt/specification/field"
                res = client.post(endpoint, json=payload)
                if res.status_code in [200, 201]:
                    res_data = res.json() if res.text else {}
                    res_id = res_data.get("Id", "")
                    emit_progress(row_num, total_rows, field_desc, f"-> ✅ Creado (FieldId: {res_id}, Tipo: {field_type_name})")
                    created_count += 1
                    # Actualizar caché
                    existing_fields[norm_name] = {"FieldId": res_id, "Name": field_name, "FieldTypeId": field_type}
                else:
                    emit_log("error", f"Fila #{row_num}: Error al crear campo ({res.status_code}): {res.text[:120]}")
                    error_count += 1

            time.sleep(0.12)

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico procesando especificaciones: {str(e)}")
