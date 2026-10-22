'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  PackageX,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Terminal,
  FileSpreadsheet,
  Info,
  X,
  Layers,
  UploadCloud,
  Warehouse,
  Boxes,
} from 'lucide-react';
import { VtexAccount } from '@/types/database';

interface StockCleanupModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedAccount: VtexAccount | undefined;
}

interface WarehouseItem {
  id: string;
  name: string;
}

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'stdout' | 'stderr' | 'info' | 'warning' | 'error' | 'success' | 'progress' | 'summary';
  message: string;
}

export default function StockCleanupModal({
  isOpen,
  onClose,
  selectedAccount,
}: StockCleanupModalProps) {
  const [warehouses, setWarehouses] = useState<WarehouseItem[]>([]);
  const [loadingWarehouses, setLoadingWarehouses] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedWarehouses, setSelectedWarehouses] = useState<Set<string>>(new Set());

  // Modo: 'auto' (todo el catálogo) vs 'file' (Excel)
  const [mode, setMode] = useState<'auto' | 'file'>('auto');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Ejecución
  const [isDryRun, setIsDryRun] = useState<boolean>(true);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  // Terminal & Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [metrics, setMetrics] = useState({ processed: 0, reset: 0, errors: 0, skipped: 0 });
  const terminalRef = useRef<HTMLDivElement>(null);

  const addLog = (
    type: 'stdout' | 'stderr' | 'info' | 'warning' | 'error' | 'success' | 'progress' | 'summary',
    message: string
  ) => {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    };
    setLogs((prev) => [...prev, entry]);
  };

  // Cargar almacenes disponibles desde la API de VTEX Logistics
  const fetchWarehouses = async () => {
    if (!selectedAccount) return;
    setLoadingWarehouses(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/stock/warehouses?accountId=${selectedAccount.id}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al obtener almacenes de VTEX');
      }
      const rawWarehouses: WarehouseItem[] = Array.isArray(data.warehouses) ? data.warehouses : [];
      setWarehouses(rawWarehouses);

      // Por defecto, pre-seleccionar todos los almacenes detectados
      const initialSelected = new Set<string>();
      rawWarehouses.forEach((w) => initialSelected.add(w.id));
      setSelectedWarehouses(initialSelected);
    } catch (err: any) {
      setFetchError(err.message || 'Error de conexión con la API de Logística de VTEX');
    } finally {
      setLoadingWarehouses(false);
    }
  };

  useEffect(() => {
    if (isOpen && selectedAccount) {
      fetchWarehouses();
    }
  }, [isOpen, selectedAccount?.id]);

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!isOpen) return null;

  const toggleWarehouse = (warehouseId: string) => {
    const next = new Set(selectedWarehouses);
    if (next.has(warehouseId)) {
      next.delete(warehouseId);
    } else {
      next.add(warehouseId);
    }
    setSelectedWarehouses(next);
  };

  const selectAllWarehouses = () => {
    setSelectedWarehouses(new Set(warehouses.map((w) => w.id)));
  };

  const deselectAllWarehouses = () => {
    setSelectedWarehouses(new Set());
  };

  const handleStartCleanup = async () => {
    if (!selectedAccount) return;
    if (selectedWarehouses.size === 0 && mode === 'auto') {
      alert('Debes seleccionar al menos un almacén / bodega para realizar la limpieza de stock.');
      return;
    }
    if (mode === 'file' && !selectedFile) {
      alert('Debes adjuntar un archivo Excel con la columna de SKU ID.');
      return;
    }

    setIsRunning(true);
    setLogs([]);
    setMetrics({ processed: 0, reset: 0, errors: 0, skipped: 0 });

    addLog(
      'info',
      `Iniciando proceso: RESETEO DE STOCK A 0 (${isDryRun ? 'SIMULACIÓN' : 'PRODUCCIÓN'})`
    );
    addLog(
      'info',
      `Cuenta: ${selectedAccount.account_name} | Modo: ${mode === 'auto' ? 'Catálogo Completo' : 'Por Archivo'}`
    );
    addLog('info', `Almacenes seleccionados: [${Array.from(selectedWarehouses).join(', ')}]`);
    if (!isDryRun) {
      addLog('warning', `⚠️ Se establecerá la cantidad en 0 para todos los SKUs procesados en los almacenes seleccionados.`);
    }

    try {
      const formData = new FormData();
      formData.append('accountId', selectedAccount.id);
      formData.append('warehouses', Array.from(selectedWarehouses).join(','));
      formData.append('dryRun', isDryRun ? 'true' : 'false');
      if (mode === 'file' && selectedFile) {
        formData.append('file', selectedFile);
      }

      const res = await fetch('/api/stock/cleanup', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson.error || `HTTP ${res.status}: Error al iniciar reseteo de stock`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No se pudo inicializar el flujo SSE');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          try {
            const jsonStr = trimmed.replace(/^data:\s*/, '');
            const event = JSON.parse(jsonStr);

            if (event.type === 'summary') {
              addLog('summary', event.message);
              if (event.meta) {
                setMetrics({
                  processed: event.meta.processed || 0,
                  reset: event.meta.created || 0,
                  errors: event.meta.errors || 0,
                  skipped: event.meta.skipped || 0,
                });
              }
            } else if (event.type === 'complete') {
              if (event.meta?.exitCode === 0) {
                addLog(
                  'success',
                  isDryRun
                    ? '🏆 Simulación de reseteo de stock completada con éxito.'
                    : '🎉 Stock de inventario reseteado a 0 exitosamente en VTEX.'
                );
              } else {
                addLog('error', `Proceso finalizado con código: ${event.meta?.exitCode}`);
              }
            } else {
              addLog(event.type || 'stdout', event.message);
            }
          } catch {
            // Ignorar líneas no JSON
          }
        }
      }
    } catch (err: any) {
      addLog('error', `Fallo de ejecución: ${err.message || err}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl flex items-center justify-center text-white shadow-md bg-gradient-to-tr from-amber-600 to-orange-500 shadow-amber-950/50">
              <PackageX className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-base text-slate-100">
                  Full Clean Up: Reseteo de Stock a 0
                </h3>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full border bg-amber-950/60 text-amber-300 border-amber-700/60">
                  Logistics Inventory Purge
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Reseteo masivo del inventario de SKUs a cantidad 0 en{' '}
                <span className="font-semibold text-amber-300">{selectedAccount?.account_name || 'cuenta VTEX'}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isRunning}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-30 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 text-sm">
          {/* Alerta explicativa */}
          <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl p-3.5 flex items-start gap-3 text-xs text-amber-200/90">
            <Info className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-300">Arquitectura de Inventario en VTEX Logistics:</p>
              <p className="mt-0.5 text-slate-400 leading-relaxed">
                Al ejecutar esta limpieza, se enviará una petición <code className="text-amber-300 font-mono">PUT /api/logistics/pvt/inventory/skus/{'{skuId}'}/warehouses/{'{warehouseId}'}</code> con <code className="text-amber-300 font-mono">quantity: 0</code> y <code className="text-amber-300 font-mono">unlimitedQuantity: false</code> para cada SKU en las bodegas seleccionadas.
              </p>
              <p className="mt-1 text-slate-500 text-[11px]">
                ℹ️ Los SKUs quedarán inmediatamente <b>sin stock disponible</b> para compra en la tienda, permitiendo iniciar una carga limpia de inventario real desde cero.
              </p>
            </div>
          </div>

          {/* Selector de Modo de Alcance */}
          <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-1.5 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => setMode('auto')}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-medium text-xs transition-all cursor-pointer ${
                mode === 'auto'
                  ? 'bg-amber-950/50 border border-amber-500/50 text-amber-200 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
              }`}
            >
              <Layers className="h-4 w-4" />
              <span>Automático (Todo el Catálogo)</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-medium text-xs transition-all cursor-pointer ${
                mode === 'file'
                  ? 'bg-amber-950/50 border border-amber-500/50 text-amber-200 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>Por Planilla Excel (Opcional)</span>
            </button>
          </div>

          {/* Subida de archivo si el modo es file */}
          {mode === 'file' && (
            <div className="space-y-3">
              <div className="px-1">
                <span className="text-xs font-semibold text-slate-200">Planilla personalizada de SKUs</span>
                <p className="text-[11px] text-slate-400">
                  Sube un archivo Excel para resetear a 0 únicamente los SKUs especificados.
                </p>
              </div>

              <div className="border-2 border-dashed border-slate-700 hover:border-amber-500/50 bg-slate-950/40 rounded-xl p-4 transition-all">
                <label className="flex flex-col items-center justify-center cursor-pointer">
                  <UploadCloud className="h-8 w-8 text-amber-400 mb-2" />
                  <span className="text-xs font-semibold text-slate-200">
                    {selectedFile ? selectedFile.name : 'Haz clic para seleccionar el Excel de SKUs'}
                  </span>
                  <span className="text-[11px] text-slate-500 mt-1">
                    Columnas requeridas: <b>SKU ID</b> (y opcionalmente <b>Almacén / Bodega</b>)
                  </span>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setSelectedFile(e.target.files[0]);
                      }
                    }}
                    className="hidden"
                  />
                </label>
                {selectedFile && (
                  <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
                    <span className="text-slate-400 truncate max-w-[70%]">
                      Archivo seleccionado: <b className="text-amber-300">{selectedFile.name}</b> ({(selectedFile.size / 1024).toFixed(1)} KB)
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="text-[11px] text-red-400 hover:text-red-300 font-semibold cursor-pointer"
                    >
                      Quitar archivo
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sección de Almacenes / Bodegas Descubiertas */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Warehouse className="h-4 w-4 text-amber-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Almacenes / Bodegas detectados en VTEX:
                </span>
                {loadingWarehouses && (
                  <span className="text-[11px] text-slate-500 flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Consultando...
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={fetchWarehouses}
                  disabled={loadingWarehouses || isRunning}
                  className="text-xs text-slate-400 hover:text-slate-200 p-1 hover:bg-slate-800 rounded transition-colors"
                  title="Recargar almacenes"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingWarehouses ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={selectAllWarehouses}
                  disabled={loadingWarehouses || warehouses.length === 0}
                  className="text-[11px] text-amber-400 hover:text-amber-300 font-semibold px-2 py-0.5 rounded bg-amber-950/30 hover:bg-amber-950/60 border border-amber-800/40 transition-colors cursor-pointer"
                >
                  Seleccionar todos
                </button>
                <button
                  type="button"
                  onClick={deselectAllWarehouses}
                  disabled={loadingWarehouses || warehouses.length === 0}
                  className="text-[11px] text-slate-400 hover:text-slate-300 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Deseleccionar todos
                </button>
              </div>
            </div>

            {fetchError ? (
              <div className="p-3 bg-red-950/30 border border-red-800/50 rounded-lg text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0" />
                <span>{fetchError}</span>
              </div>
            ) : warehouses.length === 0 && !loadingWarehouses ? (
              <p className="text-xs text-slate-500 py-3 text-center">
                No se encontraron almacenes registrados en esta cuenta.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {warehouses.map((wh) => {
                  const isChecked = selectedWarehouses.has(wh.id);

                  return (
                    <div
                      key={wh.id}
                      onClick={() => toggleWarehouse(wh.id)}
                      className={`cursor-pointer rounded-lg p-3 border transition-all flex items-center justify-between ${
                        isChecked
                          ? 'bg-amber-950/40 border-amber-500/70 text-amber-100 shadow-sm'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}} // controlado por onClick del padre
                          className="rounded border-slate-700 text-amber-600 focus:ring-amber-500/40 bg-slate-800 cursor-pointer"
                        />
                        <div className="overflow-hidden">
                          <span className="font-semibold text-xs text-slate-200 block truncate">{wh.name}</span>
                          <span className="font-mono text-[10px] text-slate-500 block truncate">ID: {wh.id}</span>
                        </div>
                      </div>
                      <Boxes className="h-4 w-4 text-amber-400/60 flex-shrink-0" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Toggle Dry-Run vs Producción */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/80 border border-slate-800">
            <div>
              <span className="text-xs font-semibold text-slate-200 block">Modo de Operación:</span>
              <span className="text-[11px] text-slate-400">
                {isDryRun
                  ? 'Simulación segura (Dry-Run): Identifica SKUs y bodegas sin mutar el inventario.'
                  : '⚠️ Modo Producción Real: El stock será reseteado a 0 unidades en VTEX Logistics.'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsDryRun(true)}
                disabled={isRunning}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                  isDryRun
                    ? 'bg-amber-600/30 text-amber-300 border border-amber-500/50 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Dry-Run
              </button>
              <button
                type="button"
                onClick={() => setIsDryRun(false)}
                disabled={isRunning}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                  !isDryRun
                    ? 'bg-amber-600 text-white shadow-md shadow-amber-950/50 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Producción
              </button>
            </div>
          </div>

          {/* Consola de Logs */}
          <div className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden flex flex-col h-56">
            <div className="px-3.5 py-2 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between text-xs">
              <span className="font-mono text-slate-400 flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-amber-400" />
                Terminal de Salida en Tiempo Real
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded bg-slate-800 border-slate-700 text-amber-500"
                  />
                  Auto-scroll
                </label>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="text-[11px] text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  Limpiar
                </button>
              </div>
            </div>

            <div
              ref={terminalRef}
              className="flex-1 p-3 font-mono text-[11px] overflow-y-auto space-y-1 select-text bg-black/40"
            >
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-600">
                  Esperando ejecución...
                </div>
              ) : (
                logs.map((log) => {
                  let colorClass = 'text-slate-300';
                  if (log.type === 'error' || log.type === 'stderr') colorClass = 'text-red-400 font-semibold';
                  if (log.type === 'warning') colorClass = 'text-amber-400';
                  if (log.type === 'success') colorClass = 'text-emerald-400 font-semibold';
                  if (log.type === 'summary') colorClass = 'text-purple-300 font-bold';
                  if (log.type === 'info') colorClass = 'text-sky-300';

                  return (
                    <div key={log.id} className="leading-tight flex items-start gap-2">
                      <span className="text-slate-600 flex-shrink-0">[{log.timestamp}]</span>
                      <span className={colorClass}>{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between">
          <div className="text-xs text-slate-400">
            {selectedWarehouses.size > 0 ? (
              <span className="flex items-center gap-1.5 text-amber-300">
                <Warehouse className="h-3.5 w-3.5 text-amber-400" />
                <b>{selectedWarehouses.size}</b> almacén(es) seleccionado(s) para reseteo.
              </span>
            ) : (
              <span className="text-amber-400">Ningún almacén seleccionado.</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isRunning}
              className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-30 cursor-pointer"
            >
              Cerrar
            </button>
            <button
              type="button"
              onClick={handleStartCleanup}
              disabled={
                isRunning ||
                (selectedWarehouses.size === 0 && mode === 'auto') ||
                (mode === 'file' && !selectedFile)
              }
              className={`flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isDryRun
                  ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-950/40'
                  : 'bg-orange-600 hover:bg-orange-500 text-white shadow-orange-950/50'
              }`}
            >
              {isRunning ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Procesando...</span>
                </>
              ) : (
                <>
                  <PackageX className="h-4 w-4" />
                  <span>
                    {isDryRun ? 'Simular Reseteo de Stock (Dry-Run)' : 'Resetear Stock a 0 en VTEX'}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
