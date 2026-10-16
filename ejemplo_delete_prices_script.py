#!/usr/bin/env python3
"""
Script para eliminar precios de SKUs en tablas de precios específicas usando la API de VTEX
Utiliza el método DELETE en el endpoint: https://api.vtex.com/{VTEX_ACCOUNT_NAME}/pricing/prices/{itemId}/fixed/{priceTableId}
"""

import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, ".."))

import pandas as pd
import requests
import time
import logging
from datetime import datetime
import json
from vtex_config import get_vtex_config

# ── Cuenta activa ──────────────────────────────────────────────
VTEX_ACCOUNT_NAME = "casamusacl"
# ──────────────────────────────────────────────────────────────

# Configurar logging
log_filename = os.path.join(SCRIPT_DIR, f'delete_prices_log_{datetime.now().strftime("%Y%m%d_%H%M%S")}.txt')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_filename),
        logging.StreamHandler()
    ]
)

class VTEXPriceDeleter:
    def __init__(self, test_mode=True):
        """
        Inicializar el eliminador de precios de VTEX
        
        Args:
            test_mode (bool): Si es True, solo simula las operaciones sin ejecutarlas
        """
        self.test_mode = test_mode
        self.load_config()
        self.setup_session()
        self.results = {
            'successful_deletions': [],
            'failed_deletions': [],
            'skipped_items': []
        }
        
    def load_config(self):
        """Cargar configuración desde el archivo .env"""
        cfg = get_vtex_config(VTEX_ACCOUNT_NAME)

        self.vtex_account = cfg['account']
        self.app_key = cfg['app_key']
        self.app_token = cfg['app_token']
        self.base_url = f"https://api.vtex.com/{self.vtex_account}/pricing/prices"
        logging.info(f"Configuración cargada para cuenta: {self.vtex_account}")
        
    def setup_session(self):
        """Configurar sesión HTTP con headers de autenticación"""
        self.session = requests.Session()
        self.session.headers.update({
            'X-VTEX-API-AppKey': self.app_key,
            'X-VTEX-API-AppToken': self.app_token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        })
        
    def load_excel_data(self, excel_file='planilla_precios_sku_delete.xlsx'):
        """
        Cargar datos del archivo Excel
        
        Args:
            excel_file (str): Ruta al archivo Excel
            
        Returns:
            pandas.DataFrame: DataFrame con los datos
        """
        try:
            if not os.path.isabs(excel_file) and not os.path.exists(excel_file):
                script_relative_path = os.path.join(SCRIPT_DIR, excel_file)
                if os.path.exists(script_relative_path):
                    excel_file = script_relative_path

            df = pd.read_excel(excel_file)
            logging.info(f"Archivo Excel cargado exitosamente: {df.shape[0]} filas")
            
            # Verificar que las columnas necesarias existen
            required_columns = ['SKU ID', 'tabla de precios']
            missing_columns = [col for col in required_columns if col not in df.columns]
            
            if missing_columns:
                raise ValueError(f"Columnas faltantes en el Excel: {missing_columns}")
                
            # Limpiar datos
            df = df.dropna()  # Eliminar filas con valores nulos
            df['SKU ID'] = df['SKU ID'].astype(str)  # Convertir SKU ID a string
            df['tabla de precios'] = df['tabla de precios'].astype(str)  # Convertir tabla de precios a string
            
            logging.info(f"Datos procesados: {df.shape[0]} filas válidas")
            return df
            
        except Exception as e:
            logging.error(f"Error al cargar el archivo Excel: {e}")
            raise
            
    def delete_price(self, sku_id, price_table_id):
        """
        Eliminar precio de un SKU en una tabla de precios específica
        
        Args:
            sku_id (str): ID del SKU
            price_table_id (str): ID de la tabla de precios
            
        Returns:
            dict: Resultado de la operación
        """
        url = f"{self.base_url}/{sku_id}/fixed/{price_table_id}"
        
        try:
            if self.test_mode:
                logging.info(f"[TEST MODE] DELETE {url}")
                return {
                    'success': True,
                    'sku_id': sku_id,
                    'price_table_id': price_table_id,
                    'status_code': 200,
                    'message': 'Simulación exitosa (modo test)'
                }
            
            response = self.session.delete(url)
            
            if response.status_code in [200, 204]:
                logging.info(f"✅ Precio eliminado exitosamente - SKU: {sku_id}, Tabla: {price_table_id}")
                return {
                    'success': True,
                    'sku_id': sku_id,
                    'price_table_id': price_table_id,
                    'status_code': response.status_code,
                    'message': 'Eliminación exitosa'
                }
            elif response.status_code == 404:
                logging.warning(f"⚠️ Precio no encontrado - SKU: {sku_id}, Tabla: {price_table_id}")
                return {
                    'success': False,
                    'sku_id': sku_id,
                    'price_table_id': price_table_id,
                    'status_code': response.status_code,
                    'message': 'Precio no encontrado'
                }
            else:
                logging.error(f"❌ Error al eliminar precio - SKU: {sku_id}, Tabla: {price_table_id}, Status: {response.status_code}")
                return {
                    'success': False,
                    'sku_id': sku_id,
                    'price_table_id': price_table_id,
                    'status_code': response.status_code,
                    'message': f'Error HTTP: {response.status_code}'
                }
                
        except requests.exceptions.RequestException as e:
            logging.error(f"❌ Error de conexión - SKU: {sku_id}, Tabla: {price_table_id}, Error: {e}")
            return {
                'success': False,
                'sku_id': sku_id,
                'price_table_id': price_table_id,
                'status_code': None,
                'message': f'Error de conexión: {str(e)}'
            }
            
    def process_deletions(self, df, delay_seconds=0.1):
        """
        Procesar todas las eliminaciones del DataFrame
        
        Args:
            df (pandas.DataFrame): DataFrame con los datos
            delay_seconds (float): Tiempo de espera entre requests (default: 0.1 segundos)
        """
        total_items = len(df)
        logging.info(f"Iniciando procesamiento de {total_items} elementos con delay de {delay_seconds}s entre requests")
        
        start_time = time.time()
        
        for index, row in df.iterrows():
            sku_id = str(row['SKU ID'])
            price_table_id = str(row['tabla de precios'])
            
            # Log cada 100 elementos para no saturar el log
            if (index + 1) % 100 == 0 or index == 0:
                elapsed = time.time() - start_time
                rate = (index + 1) / elapsed if elapsed > 0 else 0
                eta = (total_items - index - 1) / rate if rate > 0 else 0
                logging.info(f"Procesando {index + 1}/{total_items} - SKU: {sku_id}, Tabla: {price_table_id} | Velocidad: {rate:.1f} req/s | ETA: {eta/60:.1f} min")
            
            result = self.delete_price(sku_id, price_table_id)
            
            if result['success']:
                self.results['successful_deletions'].append(result)
            else:
                self.results['failed_deletions'].append(result)
                
            # Delay entre requests para no sobrecargar la API
            if delay_seconds > 0:
                time.sleep(delay_seconds)
                
        elapsed_total = time.time() - start_time
        avg_rate = total_items / elapsed_total if elapsed_total > 0 else 0
        logging.info(f"Procesamiento completado en {elapsed_total/60:.2f} minutos | Velocidad promedio: {avg_rate:.1f} req/s")
        
        # self.generate_report()
        
    def generate_report(self):
        """Generar reporte de resultados"""
        successful = len(self.results['successful_deletions'])
        failed = len(self.results['failed_deletions'])
        total = successful + failed
        
        logging.info("=" * 50)
        logging.info("REPORTE FINAL")
        logging.info("=" * 50)
        logging.info(f"Total procesados: {total}")
        logging.info(f"Eliminaciones exitosas: {successful}")
        logging.info(f"Eliminaciones fallidas: {failed}")
        logging.info(f"Tasa de éxito: {(successful/total*100):.2f}%" if total > 0 else "N/A")
        
        # Guardar reporte detallado en JSON
        report_file = os.path.join(SCRIPT_DIR, f'delete_prices_report_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
        with open(report_file, 'w', encoding='utf-8') as f:
            json.dump(self.results, f, indent=2, ensure_ascii=False)
            
        logging.info(f"Reporte detallado guardado en: {report_file}")
        
    def run_test(self, sample_size=5):
        """
        Ejecutar una prueba con una muestra pequeña de datos
        
        Args:
            sample_size (int): Número de elementos para la prueba
        """
        logging.info("EJECUTANDO MODO TEST")
        logging.info("=" * 30)
        
        df = self.load_excel_data()
        
        # Tomar una muestra pequeña para la prueba
        sample_df = df.head(sample_size)
        logging.info(f"Ejecutando test con {len(sample_df)} elementos")
        
        self.process_deletions(sample_df, delay_seconds=0.05)

def main():
    """Función principal"""
    print("🔧 Script de Eliminación de Precios VTEX")
    print("=" * 40)
    
    # Preguntar al usuario si quiere ejecutar en modo test
    while True:
        mode = input("¿Ejecutar en modo TEST? (s/n): ").lower().strip()
        if mode in ['s', 'si', 'y', 'yes']:
            test_mode = True
            break
        elif mode in ['n', 'no']:
            test_mode = False
            print("⚠️ ADVERTENCIA: Ejecutando en modo PRODUCCIÓN")
            confirm = input("¿Está seguro? Esto eliminará precios reales (s/n): ").lower().strip()
            if confirm in ['s', 'si', 'y', 'yes']:
                break
            else:
                test_mode = True
                break
        else:
            print("Por favor responda 's' para sí o 'n' para no")
    
    try:
        deleter = VTEXPriceDeleter(test_mode=test_mode)
        
        if test_mode:
            deleter.run_test()
        else:
            df = deleter.load_excel_data()
            
            print(f"Se procesarán {len(df)} elementos")
            
            # Configurar velocidad
            print("\nOpciones de velocidad:")
            print("1. Muy rápido (0.05s entre requests) - ~20 req/s")
            print("2. Rápido (0.1s entre requests) - ~10 req/s") 
            print("3. Normal (0.2s entre requests) - ~5 req/s")
            print("4. Lento (0.5s entre requests) - ~2 req/s")
            print("5. Personalizado")
            
            while True:
                speed_choice = input("Seleccione velocidad (1-5): ").strip()
                if speed_choice == "1":
                    delay = 0.05
                    break
                elif speed_choice == "2":
                    delay = 0.1
                    break
                elif speed_choice == "3":
                    delay = 0.2
                    break
                elif speed_choice == "4":
                    delay = 0.5
                    break
                elif speed_choice == "5":
                    try:
                        delay = float(input("Ingrese delay en segundos (ej: 0.1): "))
                        if delay < 0:
                            print("El delay debe ser positivo")
                            continue
                        break
                    except ValueError:
                        print("Ingrese un número válido")
                        continue
                else:
                    print("Seleccione una opción válida (1-5)")
            
            estimated_time = len(df) * delay / 60
            print(f"\nTiempo estimado: {estimated_time:.1f} minutos")
            input("Presione Enter para continuar...")
            
            deleter.process_deletions(df, delay_seconds=delay)
            
    except Exception as e:
        logging.error(f"Error fatal: {e}")
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    main()