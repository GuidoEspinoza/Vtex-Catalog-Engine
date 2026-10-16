import os
import time
import pandas as pd
from typing import Dict, Any, List, Optional
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def get_or_create_subcollection(client: VtexClient, collection_id: int, dry_run: bool) -> Optional[int]:
    """Obtiene el ID de subcolección principal o crea una nueva si no existe."""
    if dry_run:
        return 88888

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

    post_url = "/api/catalog/pvt/subcollection"
    payload = {
        "CollectionId": collection_id,
        "Name": "Grupo Principal",
        "Type": "Inclusive",
        "PreSale": False,
        "Release": False
    }

    try:
        res = client.post(post_url, json=payload)
        if res.status_code in [200, 201]:
            data = res.json()
            sub_id = data.get("Id") or data.get("id")
            if sub_id:
                return int(sub_id)
    except Exception:
        pass

    return None

def associate_sku_to_subcollection(client: VtexClient, subcollection_id: int, sku_id: int, dry_run: bool) -> bool:
    """Asocia un SKU individual a la subcolección."""
    if dry_run:
        return True

    url = f"/api/catalog/pvt/subcollection/{subcollection_id}/stockkeepingunit"
    payload = {"SkuId": int(sku_id)}
    try:
        res = client.post(url, json=payload)
        return res.status_code in [200, 201, 204]
    except Exception:
        return False

def process_collections(client: VtexClient, file_path: str, dry_run: bool = False):
    """
    Crea o actualiza colecciones dinámicas y asocia SKUs/Productos a su subcolección.
    Agrupa automáticamente los ítems por colección para evitar creaciones duplicadas.
    """
    if not os.path.exists(file_path):
        emit_log("error", f"No se encontró el archivo: {file_path}")
        return

    emit_log("info", f"Leyendo archivo de colecciones: {os.path.basename(file_path)}")

    try:
        df = pd.read_excel(file_path) if not file_path.endswith('.csv') else pd.read_csv(file_path)
        df.columns = [str(c).strip() for c in df.columns]

        # Mapeo preciso de columnas
        name_col = next((c for c in df.columns if c.lower() in ['nombre colección', 'nombre coleccion', 'nombre', 'collection', 'name']), None)
        desc_col = next((c for c in df.columns if 'descrip' in c.lower()), None)
        search_col = next((c for c in df.columns if 'buscable' in c.lower() or 'searchable' in c.lower()), None)
        highlight_col = next((c for c in df.columns if 'destacada' in c.lower() or 'highlight' in c.lower()), None)
        
        # Búsqueda estricta de ID de colección para no confundir con ID Producto / ID SKU
        col_id_col = next((c for c in df.columns if c.lower() in ['id colección', 'id coleccion', 'collection id', 'collectionid', 'id_coleccion']), None)
        prod_id_col = next((c for c in df.columns if c.lower() in ['id producto', 'id del producto', 'productid', 'producto']), None)
        sku_id_col = next((c for c in df.columns if c.lower() in ['id sku', 'sku id', 'skuid', 'sku']), None)

        if not name_col:
            emit_log("error", f"Falta la columna obligatoria de nombre de colección ('Nombre Colección'). Columnas detectadas: {list(df.columns)}")
            return

        total_rows = len(df)
        if total_rows == 0:
            emit_log("warning", "El archivo de colecciones está vacío.")
            return

        emit_log("info", f"Analizando {total_rows} filas de colecciones para '{client.account}' (Modo: {'DRY-RUN' if dry_run else 'PRODUCCIÓN'}).")

        # Agrupar registros por Colección
        collections_map: Dict[str, Dict[str, Any]] = {}

        for idx, row in df.iterrows():
            c_name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""
            if not c_name or c_name.lower() == 'nan':
                continue

            if c_name not in collections_map:
                is_searchable = True
                if search_col and pd.notna(row[search_col]):
                    val_s = str(row[search_col]).strip().upper()
                    is_searchable = val_s in ['SI', 'YES', 'TRUE', '1']

                is_highlight = False
                if highlight_col and pd.notna(row[highlight_col]):
                    val_h = str(row[highlight_col]).strip().upper()
                    is_highlight = val_h in ['SI', 'YES', 'TRUE', '1']

                col_id_val = None
                if col_id_col and pd.notna(row[col_id_col]):
                    try:
                        col_id_val = int(float(row[col_id_col]))
                    except Exception:
                        col_id_val = None

                collections_map[c_name] = {
                    "id": col_id_val,
                    "description": str(row[desc_col]).strip() if desc_col and pd.notna(row[desc_col]) else "",
                    "searchable": is_searchable,
                    "highlight": is_highlight,
                    "items": []
                }

            # Extraer SKU o Producto asociado
            sku_val = None
            if sku_id_col and pd.notna(row[sku_id_col]):
                try:
                    sku_val = int(float(row[sku_id_col]))
                except Exception:
                    pass

            prod_val = None
            if prod_id_col and pd.notna(row[prod_id_col]):
                try:
                    prod_val = int(float(row[prod_id_col]))
                except Exception:
                    pass

            if sku_val or prod_val:
                collections_map[c_name]["items"].append({"sku_id": sku_val, "prod_id": prod_val})

        emit_log("info", f"Se agruparon {len(collections_map)} colecciones únicas con sus respectivos ítems.")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        col_num = 0
        total_cols = len(collections_map)

        for col_name, c_data in collections_map.items():
            col_num += 1
            num_items = len(c_data["items"])
            col_desc = f"Colección '{col_name}' ({num_items} ítems)"

            if dry_run:
                emit_progress(col_num, total_cols, col_desc, f"-> [DRY-RUN] Válida para creación/actualización con {num_items} ítems")
                created_count += 1
                time.sleep(0.05)
                continue

            try:
                # 1. Crear o actualizar la Colección
                payload = {
                    "Name": col_name,
                    "Searchable": c_data["searchable"],
                    "Highlight": c_data["highlight"]
                }
                if c_data["id"]:
                    payload["Id"] = c_data["id"]

                res = client.post("/api/catalog/pvt/collection", json=payload)
                if res.status_code not in [200, 201]:
                    emit_log("error", f"{col_desc}: Error creando colección ({res.status_code}): {res.text[:100]}")
                    error_count += 1
                    continue

                res_json = res.json() if res.text else {}
                actual_col_id = res_json.get("Id") or c_data["id"]
                if not actual_col_id:
                    emit_log("error", f"{col_desc}: VTEX no retornó ID de colección.")
                    error_count += 1
                    continue

                created_count += 1

                # 2. Obtener o crear la Subcolección principal
                subcol_id = get_or_create_subcollection(client, actual_col_id, dry_run=False)
                if not subcol_id:
                    emit_log("warning", f"{col_desc}: Creada (ID: {actual_col_id}), pero no se pudo obtener subcolección para asociar ítems.")
                    continue

                # 3. Asociar SKUs
                items_linked = 0
                for item in c_data["items"]:
                    target_sku = item.get("sku_id")

                    # Si solo tenemos ID de producto, consultar los SKUs del producto
                    if not target_sku and item.get("prod_id"):
                        try:
                            p_res = client.get(f"/api/catalog_system/pvt/sku/stockkeepingunitByProductId/{item['prod_id']}")
                            if p_res.status_code == 200:
                                skus_list = p_res.json()
                                if isinstance(skus_list, list) and len(skus_list) > 0:
                                    target_sku = skus_list[0].get("Id")
                        except Exception:
                            pass

                    if target_sku:
                        ok = associate_sku_to_subcollection(client, subcol_id, target_sku, dry_run=False)
                        if ok:
                            items_linked += 1

                emit_progress(col_num, total_cols, col_desc, f"-> ✅ Creada (ID: {actual_col_id}, {items_linked}/{num_items} SKUs asociados)")

            except Exception as e:
                emit_log("error", f"{col_desc}: Excepción al procesar: {str(e)}")
                error_count += 1

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico en colecciones: {str(e)}")
