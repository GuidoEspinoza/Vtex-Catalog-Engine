import os
import sys
import time
import requests
from typing import Dict, Any, Optional
from core.events import emit_log

class VtexClient:
    """
    Cliente centralizado para la API de Catálogo de VTEX.
    Inyecta credenciales dinámicamente y maneja rate-limits y headers.
    """
    def __init__(self, account: str, app_key: str, app_token: str, environment: str = "vtexcommercestable"):
        self.account = account.strip()
        self.app_key = app_key.strip()
        self.app_token = app_token.strip()
        self.environment = environment.strip() or "vtexcommercestable"
        
        # Configuración de URLs
        self.base_url = f"https://{self.account}.{self.environment}.com.br" if "vtexcommercestable" in self.environment else f"https://{self.account}.myvtex.com"
        
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-VTEX-API-AppKey": self.app_key,
            "X-VTEX-API-AppToken": self.app_token,
        }
        
    def request(self, method: str, endpoint: str, **kwargs) -> requests.Response:
        """
        Ejecuta una petición HTTP con reintentos controlados y retardo de rate limit.
        """
        if not endpoint.startswith("http"):
            url = f"{self.base_url}{endpoint if endpoint.startswith('/') else '/' + endpoint}"
        else:
            url = endpoint
            
        headers = {**self.headers, **kwargs.pop("headers", {})}
        max_retries = 3
        
        for attempt in range(max_retries):
            try:
                res = requests.request(method, url, headers=headers, **kwargs)
                # VTEX Rate Limiting (HTTP 429)
                if res.status_code == 429:
                    wait_time = int(res.headers.get("Retry-After", 2))
                    emit_log("warning", f"Rate limit alcanzado (429). Esperando {wait_time}s antes de reintentar...")
                    time.sleep(wait_time)
                    continue
                return res
            except requests.RequestException as e:
                if attempt == max_retries - 1:
                    raise e
                time.sleep(1)
                
        return res
        
    def get(self, endpoint: str, **kwargs) -> requests.Response:
        return self.request("GET", endpoint, **kwargs)
        
    def post(self, endpoint: str, **kwargs) -> requests.Response:
        return self.request("POST", endpoint, **kwargs)
        
    def put(self, endpoint: str, **kwargs) -> requests.Response:
        return self.request("PUT", endpoint, **kwargs)
        
    def delete(self, endpoint: str, **kwargs) -> requests.Response:
        return self.request("DELETE", endpoint, **kwargs)
