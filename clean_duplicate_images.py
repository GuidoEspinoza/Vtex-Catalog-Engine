#!/usr/bin/env python3
"""
Script para gestionar imágenes en SKUs de VTEX:
1. Modo Duplicados (por defecto): Detecta y elimina imágenes duplicadas por SKU conservando
   la copia original/principal.
2. Modo Purga Total (--delete-all): Elimina TODAS las imágenes de los SKUs indicados
   (útil para corregir cruces erróneos de SKU ID en cargas masivas).

Soporta:
- Simulación segura (--dry-run) por defecto.
- Ejecución real (--execute).
- Filtrado por SKU individual (--sku <id>).
- Filtrado por archivo de SKUs (--skus-file <archivo.xlsx|.csv|.txt>).
- Límite de prueba (--limit <n>).
- Concurrencia ajustable (--concurrency <n>).

Uso:
    # 1. Simulación de eliminación de duplicados (todo el catálogo):
    python clean_duplicate_images/clean_duplicate_images.py --dry-run

    # 2. Simulación de PURGA TOTAL (eliminar todas las imágenes de un SKU):
    python clean_duplicate_images/clean_duplicate_images.py --sku 1852 --delete-all --dry-run

    # 3. PURGA TOTAL REAL de un SKU:
    python clean_duplicate_images/clean_duplicate_images.py --sku 1852 --delete-all --execute

    # 4. PURGA TOTAL REAL de una lista de SKUs desde un Excel:
    python clean_duplicate_images/clean_duplicate_images.py --skus-file carga_fotos.xlsx --delete-all --execute

    # 5. PURGA TOTAL REAL en todo el catálogo:
    python clean_duplicate_images/clean_duplicate_images.py --delete-all --execute
"""

import sys
import os
import argparse
import asyncio
import logging
import ssl
from pathlib import Path
from datetime import datetime
from collections import defaultdict
import aiohttp
import certifi
import pandas as pd
from tqdm.asyncio import tqdm

# Asegurar importación de vtex_config desde la raíz del proyecto
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from vtex_config import get_vtex_config

DEFAULT_ACCOUNT = "casamusacl"


def setup_logger(log_dir: Path) -> logging.Logger:
    """Configura logger con salida a archivo con timestamp y consola."""
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = log_dir / f"clean_duplicate_images_{timestamp}.log"

    logger = logging.getLogger("vtex_clean_duplicates")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.INFO)
    fh.setFormatter(formatter)
    logger.addHandler(fh)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(formatter)
    logger.addHandler(ch)

    return logger


class VTEXDuplicateImageCleaner:
    def __init__(
        self,
        account: str = DEFAULT_ACCOUNT,
        execute: bool = False,
        delete_all: bool = False,
        concurrency: int = 8,
        limit: int | None = None,
        single_sku: int | None = None,
        skus_file: str | Path | None = None,
        logger: logging.Logger | None = None,
    ):
        self.account = account
        self.dry_run = not execute
        self.delete_all = delete_all
        self.concurrency = concurrency
        self.limit = limit
        self.single_sku = single_sku
        self.skus_file = Path(skus_file) if skus_file else None
        self.logger = logger or logging.getLogger("vtex_clean_duplicates")

        # Cargar credenciales VTEX
        self.cfg = get_vtex_config(self.account)
        self.base_url = self.cfg["base_url"]
        self.headers = self.cfg["headers"]
        self.ssl_context = ssl.create_default_context(cafile=certifi.where())

        self.stats = {
            "total_skus": 0,
            "skus_with_images": 0,
            "skus_with_duplicates": 0,
            "total_files_found": 0,
            "unique_files_kept": 0,
            "files_to_delete": 0,
            "deleted_successfully": 0,
            "delete_errors": 0,
        }
        self.results_log = []

    def load_sku_ids_from_file(self, file_path: Path) -> list[int]:
        """Carga lista de SKU IDs desde un archivo Excel (.xlsx, .xls), CSV (.csv) o texto (.txt)."""
        resolved_path = file_path.resolve()
        if not resolved_path.exists():
            # Buscar relativo al directorio de ejecución o a SCRIPT_DIR
            alt_path = SCRIPT_DIR / file_path
            if alt_path.exists():
                resolved_path = alt_path.resolve()
            else:
                raise FileNotFoundError(f"No se encontró el archivo de SKUs: {file_path}")

        self.logger.info(f"📂 Cargando lista de SKUs desde archivo: {resolved_path}")
        ext = resolved_path.suffix.lower()
        sku_ids = []

        try:
            if ext in (".xlsx", ".xls"):
                df = pd.read_excel(resolved_path)
            elif ext == ".csv":
                try:
                    df = pd.read_csv(resolved_path)
                except Exception:
                    df = pd.read_csv(resolved_path, sep=";")
            elif ext == ".txt":
                with open(resolved_path, "r", encoding="utf-8") as f:
                    lines = [line.strip() for line in f if line.strip()]
                for l in lines:
                    if l.isdigit():
                        sku_ids.append(int(l))
                unique_skus = sorted(list(set(sku_ids)))
                self.logger.info(f"   Se cargaron {len(unique_skus)} SKU IDs válidos desde el archivo TXT.")
                return unique_skus
            else:
                raise ValueError(f"Formato no soportado: '{ext}'. Formatos soportados: .xlsx, .xls, .csv, .txt")

            # Detectar columna que represente el SKU ID
            target_col = None
            candidate_names = ["skuid", "sku_id", "sku", "stockkeepingunitid", "id_sku", "id", "sku id", "id sku"]
            for col in df.columns:
                col_clean = str(col).strip().lower().replace(" ", "").replace("_", "")
                if col_clean in candidate_names or "sku" in col_clean:
                    target_col = col
                    break

            if target_col is None:
                target_col = df.columns[0]
                self.logger.warning(f"No se detectó columna con nombre 'sku', usando la primera columna: '{target_col}'")

            for val in df[target_col].dropna():
                try:
                    sku_ids.append(int(float(str(val).strip())))
                except (ValueError, TypeError):
                    continue

            unique_skus = sorted(list(set(sku_ids)))
            self.logger.info(f"   Columna detectada: '{target_col}'. SKUs únicos encontrados: {len(unique_skus)}")
            return unique_skus

        except Exception as e:
            self.logger.error(f"Error procesando archivo de SKUs: {e}")
            raise

    async def fetch_all_sku_ids(self, session: aiohttp.ClientSession) -> list[int]:
        """Obtiene la lista de SKU IDs a procesar según las opciones configuradas."""
        if self.single_sku:
            self.logger.info(f"🎯 Modo SKU individual: {self.single_sku}")
            sku_ids = [self.single_sku]
        elif self.skus_file:
            sku_ids = self.load_sku_ids_from_file(self.skus_file)
        else:
            self.logger.info(f"🔍 Consultando lista completa de SKU IDs para la cuenta '{self.account}'...")
            sku_ids = []
            page = 1
            page_size = 1000

            while True:
                url = f"{self.base_url}/api/catalog_system/pvt/sku/stockkeepingunitids?page={page}&pagesize={page_size}"
                try:
                    async with session.get(url, headers=self.headers, timeout=aiohttp.ClientTimeout(total=45)) as resp:
                        if resp.status != 200:
                            self.logger.error(f"Error obteniendo SKU IDs en página {page}: HTTP {resp.status}")
                            break
                        batch = await resp.json()
                        if not batch:
                            break
                        sku_ids.extend(batch)
                        self.logger.info(f"   Página {page}: {len(batch)} SKUs encontrados (Total acumulado: {len(sku_ids)})")
                        if len(batch) < page_size:
                            break
                        page += 1
                except Exception as e:
                    self.logger.error(f"Error consultando página {page} de SKUs: {e}")
                    break

        if self.limit and self.limit > 0:
            sku_ids = sku_ids[: self.limit]
            self.logger.info(f"⚠️ Limitando ejecución a los primeros {self.limit} SKUs.")

        self.stats["total_skus"] = len(sku_ids)
        self.logger.info(f"✅ Total de SKUs a analizar: {len(sku_ids)}")
        return sku_ids

    async def get_sku_files(
        self, session: aiohttp.ClientSession, sku_id: int, semaphore: asyncio.Semaphore
    ) -> list[dict]:
        """Consulta los archivos asociados a un SKU."""
        url = f"{self.base_url}/api/catalog/pvt/stockkeepingunit/{sku_id}/file"
        async with semaphore:
            for attempt in range(3):
                try:
                    async with session.get(url, headers=self.headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        if resp.status == 200:
                            files = await resp.json()
                            return files if isinstance(files, list) else []
                        elif resp.status == 429:
                            await asyncio.sleep(1.5 * (attempt + 1))
                            continue
                        else:
                            return []
                except Exception:
                    await asyncio.sleep(1 * (attempt + 1))
            return []

    async def delete_sku_file(
        self, session: aiohttp.ClientSession, sku_id: int, file_id: int, semaphore: asyncio.Semaphore
    ) -> bool:
        """Elimina un archivo específico de un SKU mediante DELETE."""
        url = f"{self.base_url}/api/catalog/pvt/stockkeepingunit/{sku_id}/file/{file_id}"
        async with semaphore:
            for attempt in range(3):
                try:
                    async with session.delete(url, headers=self.headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        if resp.status in (200, 204):
                            return True
                        elif resp.status == 429:
                            await asyncio.sleep(1.5 * (attempt + 1))
                            continue
                        else:
                            self.logger.warning(f"Error eliminando FileId {file_id} en SKU {sku_id}: HTTP {resp.status}")
                            return False
                except Exception as e:
                    if attempt == 2:
                        self.logger.error(f"Excepción eliminando FileId {file_id}: {e}")
                        return False
                    await asyncio.sleep(1 * (attempt + 1))
            return False

    async def delete_all_sku_files(
        self, session: aiohttp.ClientSession, sku_id: int, semaphore: asyncio.Semaphore
    ) -> bool:
        """Elimina todos los archivos de un SKU mediante el endpoint masivo DELETE /stockkeepingunit/{skuId}/file."""
        url = f"{self.base_url}/api/catalog/pvt/stockkeepingunit/{sku_id}/file"
        async with semaphore:
            for attempt in range(3):
                try:
                    async with session.delete(url, headers=self.headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        if resp.status in (200, 204):
                            return True
                        elif resp.status == 429:
                            await asyncio.sleep(1.5 * (attempt + 1))
                            continue
                        else:
                            self.logger.warning(f"Error eliminando archivos de SKU {sku_id}: HTTP {resp.status}")
                            return False
                except Exception as e:
                    if attempt == 2:
                        self.logger.error(f"Excepción eliminando archivos de SKU {sku_id}: {e}")
                        return False
                    await asyncio.sleep(1 * (attempt + 1))
            return False

    def identify_duplicates(self, files: list[dict]) -> tuple[list[dict], list[dict]]:
        """
        Agrupa los archivos por su nombre/clave y separa la copia a conservar
        de las copias redundantes a eliminar.
        """
        if not files or len(files) <= 1:
            return files, []

        grouped = defaultdict(list)
        for f in files:
            raw_name = (f.get("Name") or "").strip()
            label = (f.get("Label") or "").strip()
            key = raw_name.lower() if raw_name else f"label_{label.lower()}"
            grouped[key].append(f)

        kept = []
        to_delete = []

        for key, group in grouped.items():
            if len(group) == 1:
                kept.append(group[0])
            else:
                # Ordenar para conservar el prioritario:
                # 1. Si IsMain == True primero
                # 2. Por Id más antiguo (menor Id)
                sorted_group = sorted(
                    group,
                    key=lambda x: (not x.get("IsMain", False), x.get("Id", 999999999)),
                )
                kept.append(sorted_group[0])
                to_delete.extend(sorted_group[1:])

        return kept, to_delete

    def identify_files_to_delete(self, files: list[dict]) -> tuple[list[dict], list[dict]]:
        """
        Determina qué archivos conservar y cuáles eliminar según el modo activo:
        - Si delete_all es True: marca TODAS las imágenes para eliminación (0 conservadas).
        - Si delete_all es False: conserva 1 copia legítima y elimina las copias duplicadas.
        """
        if not files:
            return [], []

        if self.delete_all:
            return [], list(files)

        return self.identify_duplicates(files)

    async def run(self):
        start_time = datetime.now()

        action_mode_str = "🚨 MODO PURGA TOTAL: ELIMINAR TODAS LAS IMÁGENES (--delete-all)" if self.delete_all else "🧹 MODO DUPLICADOS: CONSERVAR ORIGINAL Y BORRAR COPIAS"
        safety_str = "🔍 SIMULACIÓN (DRY-RUN - No se modificará nada)" if self.dry_run else "⚠️ EJECUCIÓN REAL (Se aplicarán cambios en VTEX)"

        self.logger.info("=" * 70)
        self.logger.info("🛠️ GESTOR Y LIMPIADOR DE IMÁGENES VTEX")
        self.logger.info(f"   Cuenta:       {self.account}")
        self.logger.info(f"   Operación:    {action_mode_str}")
        self.logger.info(f"   Seguridad:    {safety_str}")
        self.logger.info(f"   Concurrencia: {self.concurrency}")
        if self.skus_file:
            self.logger.info(f"   Origen SKUs:  Archivo -> {self.skus_file}")
        elif self.single_sku:
            self.logger.info(f"   Origen SKUs:  SKU único -> {self.single_sku}")
        else:
            self.logger.info(f"   Origen SKUs:  Catálogo completo de la tienda")
        self.logger.info("=" * 70)

        connector = aiohttp.TCPConnector(ssl=self.ssl_context, limit=self.concurrency + 5)
        async with aiohttp.ClientSession(connector=connector) as session:
            # 1. Obtener SKUs a procesar
            sku_ids = await self.fetch_all_sku_ids(session)
            if not sku_ids:
                self.logger.warning("No se encontraron SKUs para procesar.")
                return

            # 2. Consultar archivos por SKU
            self.logger.info("📦 Escaneando archivos asociados a cada SKU...")
            api_sem = asyncio.Semaphore(self.concurrency)

            async def scan_sku(sku_id, pbar):
                files = await self.get_sku_files(session, sku_id, api_sem)
                pbar.update(1)
                return sku_id, files

            sku_files_map = {}
            with tqdm(total=len(sku_ids), desc="Escaneando SKUs", unit="sku") as pbar:
                tasks = [scan_sku(sku_id, pbar) for sku_id in sku_ids]
                results = await asyncio.gather(*tasks)
                for sku_id, files in results:
                    sku_files_map[sku_id] = files

            # 3. Analizar imágenes según el modo
            all_deletion_tasks = []  # Tuplas: (sku_id, file_id, file_name, archive_id)

            for sku_id, files in sku_files_map.items():
                file_count = len(files)
                self.stats["total_files_found"] += file_count
                if file_count > 0:
                    self.stats["skus_with_images"] += 1

                kept, to_delete = self.identify_files_to_delete(files)
                self.stats["unique_files_kept"] += len(kept)
                self.stats["files_to_delete"] += len(to_delete)

                has_deletions = len(to_delete) > 0
                if has_deletions and not self.delete_all:
                    self.stats["skus_with_duplicates"] += 1

                for d in to_delete:
                    all_deletion_tasks.append((sku_id, d.get("Id"), d.get("Name"), d.get("ArchiveId")))

                status_label = "SIN_IMAGENES"
                if file_count > 0:
                    if self.delete_all:
                        status_label = "MARCADAS_PARA_PURGA_TOTAL"
                    elif has_deletions:
                        status_label = "CON_DUPLICADOS"
                    else:
                        status_label = "OK"

                self.results_log.append({
                    "sku_id": sku_id,
                    "total_files": file_count,
                    "kept_files": len(kept),
                    "deleted_files": len(to_delete),
                    "kept_file_ids": [k.get("Id") for k in kept],
                    "deleted_file_ids": [d.get("Id") for d in to_delete],
                    "status": status_label,
                })

            self.logger.info("\n" + "=" * 70)
            self.logger.info("📊 RESULTADOS DEL DIAGNÓSTICO:")
            self.logger.info(f"   Total SKUs analizados:                      {len(sku_ids)}")
            self.logger.info(f"   SKUs que contienen imágenes:                {self.stats['skus_with_images']}")
            self.logger.info(f"   Total de imágenes encontradas en catálogo:  {self.stats['total_files_found']}")
            if self.delete_all:
                self.logger.info(f"   🚨 Imágenes marcadas para ELIMINAR TOTAL:   {self.stats['files_to_delete']}")
                self.logger.info(f"   Imágenes que se conservarán:                0")
            else:
                self.logger.info(f"   Imágenes únicas legítimas a conservar:      {self.stats['unique_files_kept']}")
                self.logger.info(f"   SKUs con imágenes duplicadas:               {self.stats['skus_with_duplicates']}")
                self.logger.info(f"   Imágenes duplicadas a eliminar:             {self.stats['files_to_delete']}")
            self.logger.info("=" * 70 + "\n")

            # 4. Ejecución de eliminación (si no es dry-run)
            if self.dry_run:
                self.logger.info("💡 Fin de la simulación. Ninguna imagen fue eliminada.")
                self.logger.info("   Para ejecutar la eliminación definitiva, corre el script agregando: --execute\n")
            else:
                if not all_deletion_tasks:
                    self.logger.info("✨ No hay imágenes para eliminar.")
                else:
                    action_word = "imágenes (purga total)" if self.delete_all else "duplicados"
                    self.logger.info(f"🗑️ Eliminando {len(all_deletion_tasks)} {action_word} en VTEX...")
                    del_sem = asyncio.Semaphore(self.concurrency)

                    async def run_delete(task, pbar):
                        sku_id, file_id, file_name, archive_id = task
                        success = await self.delete_sku_file(session, sku_id, file_id, del_sem)
                        if success:
                            self.stats["deleted_successfully"] += 1
                        else:
                            self.stats["delete_errors"] += 1
                        pbar.update(1)

                    with tqdm(total=len(all_deletion_tasks), desc=f"Eliminando {action_word}", unit="img") as pbar:
                        delete_coros = [run_delete(t, pbar) for t in all_deletion_tasks]
                        await asyncio.gather(*delete_coros)

                    self.logger.info(f"✅ Eliminadas con éxito en VTEX: {self.stats['deleted_successfully']}")
                    if self.stats["delete_errors"] > 0:
                        self.logger.warning(f"⚠️ Errores al eliminar: {self.stats['delete_errors']}")

        # 5. Generar reporte CSV
        duration = datetime.now() - start_time
        report_filename = "resumen_purga_total.csv" if self.delete_all else "resumen_limpieza.csv"
        report_path = SCRIPT_DIR / report_filename
        if self.results_log:
            df = pd.DataFrame(self.results_log)
            df.to_csv(report_path, index=False, encoding="utf-8-sig")
            self.logger.info(f"📄 Reporte detallado guardado en: {report_path.resolve()}")

        self.logger.info("=" * 70)
        self.logger.info("✨ PROCESO COMPLETADO")
        self.logger.info(f"   Tiempo total: {duration}")
        self.logger.info("=" * 70)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Detecta y elimina imágenes duplicadas o purga todas las imágenes en SKUs de VTEX."
    )
    parser.add_argument(
        "--account",
        type=str,
        default=DEFAULT_ACCOUNT,
        help=f"Cuenta VTEX (default: {DEFAULT_ACCOUNT})",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Aplica la eliminación real en VTEX. Por defecto el script corre en modo seguro (--dry-run).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Solo simula y reporta sin borrar nada (activo por defecto si no pasas --execute).",
    )
    parser.add_argument(
        "--delete-all",
        action="store_true",
        help="MODO PURGA TOTAL: Elimina TODAS las imágenes de los SKUs procesados (no solo duplicadas).",
    )
    parser.add_argument(
        "--skus-file",
        type=str,
        default=None,
        help="Ruta a un archivo (.xlsx, .xls, .csv, .txt) con los SKU IDs a procesar.",
    )
    parser.add_argument(
        "--sku",
        type=int,
        default=None,
        help="Procesar únicamente un SKU específico (ej: --sku 670 o --sku 1852).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Límite de SKUs a procesar para pruebas (ej: --limit 50).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=8,
        help="Concurrencia de solicitudes a la API de VTEX (default: 8).",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    logger = setup_logger(SCRIPT_DIR / "logs")

    cleaner = VTEXDuplicateImageCleaner(
        account=args.account,
        execute=args.execute,
        delete_all=args.delete_all,
        concurrency=args.concurrency,
        limit=args.limit,
        single_sku=args.sku,
        skus_file=args.skus_file,
        logger=logger,
    )

    try:
        asyncio.run(cleaner.run())
    except KeyboardInterrupt:
        logger.warning("\n⚠️ Proceso interrumpido por el usuario.")
    except Exception as e:
        logger.exception(f"❌ Error fatal: {e}")


if __name__ == "__main__":
    main()
