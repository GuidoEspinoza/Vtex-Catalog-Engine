import os
import time
import pandas as pd
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def process_product_specs(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Asigna especificaciones/atributos a productos existentes en VTEX.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo asignación de especificaciones: {os.path.basename(file_path)}")

    try:
        df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
        df.columns = [str(c).strip() for c in df.columns]

        prod_id_col = next((c for c in df.columns if 'product' in c.lower() or 'producto' in c.lower()), None)
        field_id_col = next((c for c in df.columns if 'field' in c.lower() or 'atributo' in c.lower()), None)
        value_col = next((c for c in df.columns if 'valor' in c.lower() or 'value' in c.lower()), None)

        if not prod_id_col or not field_id_col or not value_col:
            emit_log("error", f"Faltan columnas obligatorias ('ID Producto', 'ID Atributo', 'Valor'). Detectadas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo no contiene filas.")
            return

        emit_log("info", f"Asignando {total_rows} atributos a productos para '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        for idx, row in df.iterrows():
            row_num = idx + 1
            raw_prod = row[prod_id_col]
            raw_field = row[field_id_col]
            val = str(row[value_col]).strip() if pd.notna(row[value_col]) else ""

            if pd.isna(raw_prod) or pd.isna(raw_field) or not val:
                emit_log("warning", f"Fila #{row_num}: Datos incompletos.")
                skipped_count += 1
                continue

            try:
                prod_id = int(float(raw_prod))
                field_id = int(float(raw_field))
            except (ValueError, TypeError):
                emit_log("error", f"Fila #{row_num}: Formato de ID inválido.")
                error_count += 1
                continue

            payload = {
                "FieldId": field_id,
                "FieldValues": [val]
            }

            desc = f"Prod {prod_id} -> Field {field_id} ('{val}')"

            if dry_run:
                # Validar existencia del Producto
                check_prod = client.get(f"/api/catalog/pvt/product/{prod_id}")
                if check_prod.status_code == 200:
                    emit_progress(row_num, total_rows, desc, "-> [DRY-RUN] Producto verificado en VTEX")
                    updated_count += 1
                else:
                    emit_log("warning", f"Fila #{row_num}: Producto {prod_id} no encontrado en VTEX (HTTP {check_prod.status_code})")
                    error_count += 1
            else:
                try:
                    url = f"/api/catalog_system/pvt/products/{prod_id}/specification"
                    res = client.post(url, json=payload)
                    if res.status_code in [200, 201, 204]:
                        emit_progress(row_num, total_rows, desc, "-> ✅ Asignado")
                        updated_count += 1
                    else:
                        emit_log("error", f"Fila #{row_num}: Error ({res.status_code}): {res.text[:120]}")
                        error_count += 1
                except Exception as e:
                    emit_log("error", f"Fila #{row_num}: Error de red: {str(e)}")
                    error_count += 1

            time.sleep(0.15)

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico asignando atributos: {str(e)}")
