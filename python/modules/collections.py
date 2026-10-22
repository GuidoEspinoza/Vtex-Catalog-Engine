import os
import time
import urllib.parse
from datetime import datetime, timedelta
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List, Optional, Set
from core.vtex_client import VtexClient
from core.events import emit_log, emit_progress, emit_summary

def find_collection_by_name(client: VtexClient, name: str) -> Optional[int]:
    """Busca si ya existe una colección con este nombre exacto en VTEX."""
    try:
        encoded = urllib.parse.quote(name.strip())
        res = client.get(f"/api/catalog_system/pvt/collection/search/{encoded}?pageSize=20")
        if res.status_code == 200:
            data = res.json()
            items = data.get("items", [])
            for item in items:
                if str(item.get("name", "")).strip().lower() == name.strip().lower():
                    return int(item.get("id"))
    except Exception:
        pass
    return None

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

def parse_id_list(val) -> List[int]:
    """Extrae una lista de IDs numéricos admitiendo enteros, cadenas simples o cadenas separadas por comas, punto y coma o espacios."""
    if pd.isna(val):
        return []
    val_str = str(val).strip()
    if not val_str or val_str.lower() == 'nan':
        return []
    import re
    tokens = re.split(r'[,;|\s\n\r]+', val_str)
    res = []
    for t in tokens:
        clean = t.strip()
        if not clean:
            continue
        try:
            num = int(float(clean))
            if num > 0:
                res.append(num)
        except (ValueError, TypeError):
            continue
    return res

def process_collections(client: VtexClient, file_path: str, dry_run: bool = False, max_workers: int = 8):
    """
    Crea o actualiza colecciones dinámicas y asocia SKUs/Productos a su subcolección.
    Agrupa automáticamente los ítems por colección para evitar creaciones duplicadas.
    Admite IDs de producto y SKU en filas individuales O separados por comas en la misma celda.
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
        prod_id_col = next((c for c in df.columns if c.lower() in ['id producto', 'id del producto', 'id productos', 'productid', 'producto', 'productos']), None)
        sku_id_col = next((c for c in df.columns if c.lower() in ['id sku', 'sku id', 'id skus', 'skuid', 'sku', 'skus']), None)

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
                    "sku_ids": set(),
                    "prod_ids": set()
                }

            # Extraer SKU o Producto asociado (soporta tanto un ID como lista separada por comas)
            if sku_id_col and pd.notna(row[sku_id_col]):
                for s_id in parse_id_list(row[sku_id_col]):
                    collections_map[c_name]["sku_ids"].add(s_id)

            if prod_id_col and pd.notna(row[prod_id_col]):
                for p_id in parse_id_list(row[prod_id_col]):
                    collections_map[c_name]["prod_ids"].add(p_id)

        emit_log("info", f"Se agruparon {len(collections_map)} colecciones únicas con sus respectivos ítems.")

        created_count = 0
        updated_count = 0
        error_count = 0
        skipped_count = 0

        col_num = 0
        total_cols = len(collections_map)

        now = datetime.now()
        default_date_from = now.strftime("%Y-%m-%dT00:00:00")
        default_date_to = (now + timedelta(days=3650)).strftime("%Y-%m-%dT00:00:00")

        for col_name, c_data in collections_map.items():
            col_num += 1
            num_skus = len(c_data["sku_ids"])
            num_prods = len(c_data["prod_ids"])
            col_desc = f"Colección '{col_name}' ({num_prods} productos, {num_skus} SKUs directos)"

            if dry_run:
                emit_progress(col_num, total_cols, col_desc, f"-> [DRY-RUN] Válida para creación/actualización con {num_prods} productos y {num_skus} SKUs")
                created_count += 1
                time.sleep(0.05)
                continue

            try:
                # 1. Determinar si la colección ya existe (por ID explícito o por Nombre exacto)
                existing_col_id = c_data["id"]
                if not existing_col_id:
                    existing_col_id = find_collection_by_name(client, col_name)

                # Construir payload completo requerido por la API de VTEX
                payload = {
                    "Name": col_name,
                    "Description": c_data["description"] if c_data["description"] else col_name,
                    "Searchable": c_data["searchable"],
                    "Highlight": c_data["highlight"],
                    "DateFrom": default_date_from,
                    "DateTo": default_date_to
                }

                actual_col_id = None
                action_label = ""

                if existing_col_id:
                    # Actualizar colección existente
                    payload["Id"] = existing_col_id
                    put_res = client.put(f"/api/catalog/pvt/collection/{existing_col_id}", json=payload)
                    if put_res.status_code in [200, 201]:
                        actual_col_id = existing_col_id
                        action_label = "Actualizada"
                        updated_count += 1
                    else:
                        emit_log("warning", f"{col_desc}: Falló actualización de colección ID {existing_col_id} ({put_res.status_code}), intentando creación...")

                if not actual_col_id:
                    # Crear nueva colección
                    res = client.post("/api/catalog/pvt/collection", json=payload)
                    if res.status_code not in [200, 201]:
                        emit_log("error", f"{col_desc}: Error creando colección ({res.status_code}): {res.text[:120]}")
                        error_count += 1
                        continue

                    res_json = res.json() if res.text else {}
                    actual_col_id = res_json.get("Id")
                    action_label = "Creada"
                    created_count += 1

                if not actual_col_id:
                    emit_log("error", f"{col_desc}: VTEX no retornó ID de colección.")
                    error_count += 1
                    continue

                # 2. Obtener o crear la Subcolección principal
                subcol_id = get_or_create_subcollection(client, actual_col_id, dry_run=False)
                if not subcol_id:
                    emit_log("warning", f"{col_desc}: {action_label} (ID: {actual_col_id}), pero no se pudo obtener subcolección para asociar ítems.")
                    continue

                # 3. Consolidar todos los SKUs
                all_target_skus = set(c_data["sku_ids"])

                # Si no se dieron SKUs directos pero sí productos, consultar en paralelo
                if len(all_target_skus) == 0 and c_data["prod_ids"]:
                    emit_log("info", f"{col_desc}: Consultando SKUs para {len(c_data['prod_ids'])} productos en paralelo...")
                    def fetch_product_skus(p_id):
                        try:
                            p_res = client.get(f"/api/catalog_system/pvt/sku/stockkeepingunitByProductId/{p_id}")
                            if p_res.status_code == 200:
                                skus_list = p_res.json()
                                if isinstance(skus_list, list):
                                    return [int(s.get("Id") or s.get("id")) for s in skus_list if s.get("Id") or s.get("id")]
                        except Exception:
                            pass
                        return []

                    with ThreadPoolExecutor(max_workers=max_workers) as executor:
                        futures = [executor.submit(fetch_product_skus, p_id) for p_id in c_data["prod_ids"]]
                        for future in as_completed(futures):
                            for s_id in future.result():
                                all_target_skus.add(s_id)

                # 4. Vincular SKUs concurrentemente a la subcolección
                items_linked = 0
                items_total = len(all_target_skus)

                if items_total > 0:
                    def link_sku_worker(s_id: int):
                        return associate_sku_to_subcollection(client, subcol_id, s_id, dry_run=False)

                    with ThreadPoolExecutor(max_workers=max_workers) as executor:
                        sku_futures = {executor.submit(link_sku_worker, s_id): s_id for s_id in all_target_skus}
                        for future in as_completed(sku_futures):
                            if future.result():
                                items_linked += 1

                emit_progress(
                    col_num,
                    total_cols,
                    col_desc,
                    f"-> ✅ {action_label} (ID: {actual_col_id}, {items_linked}/{items_total} SKUs vinculados)"
                )

            except Exception as e:
                emit_log("error", f"{col_desc}: Excepción al procesar: {str(e)}")
                error_count += 1

        emit_summary(total_rows, created_count, updated_count, error_count, skipped_count, dry_run)

    except Exception as e:
        emit_log("error", f"Error crítico en colecciones: {str(e)}")
