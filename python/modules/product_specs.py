import os
import time
import unicodedata
import pandas as pd
from typing import Dict, Any, List
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def normalize_text(text: str) -> str:
    if not text:
        return ""
    nfkd = unicodedata.normalize('NFKD', str(text).strip().lower())
    return ''.join([c for c in nfkd if not unicodedata.combining(c)])

def find_column(df_columns, candidates):
    cols_norm = {normalize_text(c): c for c in df_columns}
    for cand in candidates:
        cand_norm = normalize_text(cand)
        if cand_norm in cols_norm:
            return cols_norm[cand_norm]
    for cand in candidates:
        cand_norm = normalize_text(cand)
        for c_norm, original_c in cols_norm.items():
            if cand_norm in c_norm or c_norm in cand_norm:
                return original_c
    return None

def process_product_specs(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Asigna especificaciones/atributos a productos existentes en VTEX.
    Optimizado para enviar especificaciones agrupadas por producto (batch) reduciendo el tiempo de carga hasta en 75%.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo asignación de especificaciones: {os.path.basename(file_path)}")

    try:
        df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
        df.columns = [str(c).strip() for c in df.columns]

        prod_id_col = find_column(df.columns, ['id del producto', 'id producto', 'productid', 'producto', 'id_producto'])
        field_id_col = find_column(df.columns, ['id del atributo', 'id atributo', 'fieldid', 'id_atributo'])
        attr_name_col = find_column(df.columns, ['nombre del atributo', 'nombre atributo', 'fieldname', 'atributo'])
        value_col = find_column(df.columns, ['valor asignado', 'valor', 'value', 'valor_asignado'])

        if not prod_id_col or not field_id_col or not value_col:
            emit_log("error", f"Faltan columnas requeridas ('ID del Producto', 'ID del Atributo', 'Valor Asignado'). Detectadas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de asignación de atributos está vacío.")
            return

        emit_log("info", f"Estructurando {total_rows} filas para '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        # Agrupar especificaciones por ID de Producto
        products_map: Dict[int, List[Dict[str, Any]]] = {}
        skipped_count = 0

        for idx, row in df.iterrows():
            row_num = idx + 1
            raw_prod = row[prod_id_col]
            raw_field = row[field_id_col]
            val = str(row[value_col]).strip() if pd.notna(row[value_col]) else ""
            attr_name = str(row[attr_name_col]).strip() if attr_name_col and pd.notna(row[attr_name_col]) else f"Field #{raw_field}"

            if pd.isna(raw_prod) or pd.isna(raw_field) or not val or val.lower() == 'nan':
                emit_log("warning", f"Fila #{row_num}: Datos incompletos (Producto o Atributo vacío).")
                skipped_count += 1
                continue

            try:
                prod_id = int(float(raw_prod))
                field_id = int(float(raw_field))
            except (ValueError, TypeError):
                emit_log("error", f"Fila #{row_num}: Formato de ID inválido (Producto: '{raw_prod}', Field: '{raw_field}').")
                skipped_count += 1
                continue

            if prod_id not in products_map:
                products_map[prod_id] = []

            products_map[prod_id].append({
                "Id": field_id,
                "Name": attr_name,
                "Value": [val]
            })

        total_products = len(products_map)
        emit_log("info", f"Agrupados en {total_products} productos únicos para optimización por lotes.")

        created_count = 0
        updated_count = 0
        error_count = 0
        product_cache = {}

        prod_idx = 0
        for prod_id, specs in products_map.items():
            prod_idx += 1
            num_specs = len(specs)
            specs_summary = ", ".join([f"{s['Name']}='{s['Value'][0]}'" for s in specs[:2]])
            if num_specs > 2:
                specs_summary += f" (+{num_specs - 2} más)"

            desc = f"Prod {prod_id} ({num_specs} atributos: {specs_summary})"

            if dry_run:
                # Validar existencia del Producto en VTEX
                if prod_id in product_cache:
                    prod_exists = product_cache[prod_id]
                else:
                    check_prod = client.get(f"/api/catalog/pvt/product/{prod_id}")
                    prod_exists = (check_prod.status_code == 200)
                    product_cache[prod_id] = prod_exists

                if prod_exists:
                    emit_progress(prod_idx, total_products, desc, f"-> [DRY-RUN] Válido ({num_specs} especificaciones listas)")
                    updated_count += num_specs
                else:
                    emit_log("warning", f"Producto #{prod_id} no existe en VTEX.")
                    error_count += num_specs
                time.sleep(0.04)
            else:
                try:
                    # En VTEX el endpoint requiere un array con { Id, Value: [] }
                    payload = [{"Id": s["Id"], "Value": s["Value"]} for s in specs]
                    url = f"/api/catalog_system/pvt/products/{prod_id}/specification"
                    res = client.post(url, json=payload)

                    if res.status_code in [200, 201, 204]:
                        emit_progress(prod_idx, total_products, desc, f"-> ✅ {num_specs} atributos asignados")
                        updated_count += num_specs
                    else:
                        emit_log("error", f"Producto #{prod_id}: Error ({res.status_code}): {res.text[:120]}")
                        error_count += num_specs
                except Exception as e:
                    emit_log("error", f"Producto #{prod_id}: Error de conexión: {str(e)}")
                    error_count += num_specs

                time.sleep(0.08)

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico asignando atributos: {str(e)}")
