import os
import time
import pandas as pd
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

# Tipos de especificación en VTEX que admiten lista de opciones predefinidas en catálogo:
# 5: Combo / Select
# 6: Radio
# 7: CheckBox
#
# Tipos que NO admiten valores en /specificationvalue (se cargan directo al Producto/SKU):
# 1: Texto
# 2: Texto Multilínea
# 4: Fecha
# 8: Texto Indexado
# 9: Texto Indexado Multilínea
ACCEPTABLE_SPEC_VALUE_TYPE_IDS = {5, 6, 7}

def find_column(df_columns, candidates):
    cols_lower = {str(c).strip().lower(): c for c in df_columns}
    for cand in candidates:
        cand_lower = cand.strip().lower()
        if cand_lower in cols_lower:
            return cols_lower[cand_lower]
    for cand in candidates:
        cand_lower = cand.strip().lower()
        for c_lower, original_c in cols_lower.items():
            if cand_lower in c_lower:
                return original_c
    return None

def parse_bool(val, default=True):
    if pd.isna(val):
        return default
    val_str = str(val).strip().upper()
    return val_str in ["SI", "SÍ", "YES", "TRUE", "1"]

def process_spec_values(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Carga valores u opciones predefinidas para campos de especificación (Combos, Radios, Checkboxes).
    Valida la existencia del FieldId y su compatibilidad de tipo contra VTEX Catalog API.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo valores de especificación: {os.path.basename(file_path)}")

    try:
        df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
        df.columns = [str(c).strip() for c in df.columns]

        field_id_col = find_column(df.columns, ['id del atributo', 'fieldid', 'id atributo', 'id de atributo', 'id'])
        attr_name_col = find_column(df.columns, ['nombre del atributo', 'nombre de atributo', 'fieldname', 'nombre', 'atributo'])
        value_col = find_column(df.columns, ['valor', 'value', 'texto', 'text'])
        position_col = find_column(df.columns, ['posición', 'posicion', 'position'])
        active_col = find_column(df.columns, ['activo', 'isactive'])

        if not field_id_col or not value_col:
            emit_log("error", f"Faltan columnas requeridas ('ID del Atributo' y 'Valor'). Detectadas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de valores de especificación está vacío.")
            return

        emit_log("info", f"Procesando {total_rows} opciones de especificación para '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        # Caché de atributos: { field_id: { "exists": bool, "name": str, "type_id": int, "type_name": str, "accepts_values": bool } }
        field_cache = {}

        endpoint_value = "/api/catalog/pvt/specificationvalue"

        for idx, row in df.iterrows():
            row_num = idx + 1
            raw_field_id = row[field_id_col]
            val_text = str(row[value_col]).strip() if pd.notna(row[value_col]) else ""

            if pd.isna(raw_field_id) or not val_text or val_text.lower() == 'nan':
                emit_log("warning", f"Fila #{row_num}: Omitida por FieldId o Valor vacío.")
                skipped_count += 1
                continue

            try:
                field_id = int(float(raw_field_id))
            except (ValueError, TypeError):
                emit_log("error", f"Fila #{row_num}: FieldId inválido '{raw_field_id}'.")
                error_count += 1
                continue

            position = int(float(row[position_col])) if position_col and pd.notna(row[position_col]) else 1
            is_active = parse_bool(row[active_col], default=True) if active_col else True

            # Validar existencia y tipo de campo en VTEX con caché
            if field_id not in field_cache:
                check_field = client.get(f"/api/catalog_system/pub/specification/fieldGet/{field_id}")
                if check_field.status_code == 200:
                    f_data = check_field.json() if check_field.text else {}
                    t_id = f_data.get("FieldTypeId", 1)
                    t_name = f_data.get("FieldTypeName", "Desconocido")
                    field_cache[field_id] = {
                        "exists": True,
                        "name": f_data.get("Name", f"Field #{field_id}"),
                        "type_id": t_id,
                        "type_name": t_name,
                        "accepts_values": t_id in ACCEPTABLE_SPEC_VALUE_TYPE_IDS
                    }
                else:
                    field_cache[field_id] = {
                        "exists": False,
                        "status": check_field.status_code
                    }

            cached_info = field_cache[field_id]
            if not cached_info["exists"]:
                emit_log("error", f"Fila #{row_num}: El Atributo con FieldId {field_id} no existe en VTEX (HTTP {cached_info.get('status', 404)}).")
                error_count += 1
                continue

            field_name = cached_info["name"]
            type_name = cached_info.get("type_name", "Desconocido")
            type_id = cached_info.get("type_id", 0)

            # Validación de compatibilidad arquitectural de VTEX
            if not cached_info["accepts_values"]:
                emit_log(
                    "error",
                    f"Fila #{row_num}: El campo '{field_name}' (ID: {field_id}) es de tipo '{type_name}' (TypeId: {type_id}) "
                    f"y NO acepta opciones en el catálogo. En VTEX solo Combo (5), Radio (6) y Checkbox (7) admiten valores predefinidos. "
                    f"Los campos de tipo '{type_name}' deben asignarse directamente a nivel de producto/SKU."
                )
                error_count += 1
                continue

            desc = f"FieldId {field_id} ('{field_name}') -> '{val_text}'"

            payload = {
                "FieldId": field_id,
                "Name": val_text,
                "Text": val_text,
                "IsActive": is_active,
                "Position": position
            }

            if dry_run:
                emit_progress(row_num, total_rows, desc, f"-> [DRY-RUN] Válido para creación en '{field_name}' ({type_name})")
                created_count += 1
            else:
                try:
                    res = client.post(endpoint_value, json=payload)
                    if res.status_code in [200, 201]:
                        res_data = res.json() if res.text else {}
                        v_id = res_data.get("FieldValueId", "")
                        emit_progress(row_num, total_rows, desc, f"-> ✅ Creado (ValueId: {v_id})")
                        created_count += 1
                    elif res.status_code == 400 and ("already been created" in res.text or "has already been created" in res.text):
                        emit_progress(row_num, total_rows, desc, f"-> ℹ️ Ya existente en VTEX")
                        updated_count += 1
                    else:
                        emit_log("error", f"Fila #{row_num}: Error ({res.status_code}): {res.text[:120]}")
                        error_count += 1
                except Exception as e:
                    emit_log("error", f"Fila #{row_num}: Error de conexión: {str(e)}")
                    error_count += 1

                time.sleep(0.08)

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico en valores de especificación: {str(e)}")
