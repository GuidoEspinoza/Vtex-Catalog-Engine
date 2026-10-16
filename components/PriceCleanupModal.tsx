'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Trash2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Terminal,
  FileSpreadsheet,
  Info,
  X,
  ShieldAlert,
  Layers,
  Sparkles,
  UploadCloud,
  Download,
} from 'lucide-react';
import { VtexAccount } from '@/types/database';

interface PriceCleanupModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedAccount: VtexAccount | undefined;
}

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'stdout' | 'stderr' | 'info' | 'warning' | 'error' | 'success' | 'progress' | 'summary';
  message: string;
}

export default function PriceCleanupModal({
  isOpen,
  onClose,
  selectedAccount,
}: PriceCleanupModalProps) {
  const [tables, setTables] = useState<string[]>([]);
  const [loadingTables, setLoadingTables] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());

  // Modo: 'auto' (todo el catálogo) vs 'file' (Excel)
  const [mode, setMode] = useState<'auto' | 'file'>('auto');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Ejecución
  const [isDryRun, setIsDryRun] = useState<boolean>(true);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  // Terminal & Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [metrics, setMetrics] = useState({ processed: 0, deleted: 0, errors: 0, skipped: 0 });
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

  // Cargar tablas de precios disponibles desde la API de VTEX
  const fetchPriceTables = async () => {
    if (!selectedAccount) return;
    setLoadingTables(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/pricing/tables?accountId=${selectedAccount.id}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al obtener listas de precios');
      }
      const rawTables: string[] = Array.isArray(data.tables) ? data.tables : [];
      setTables(rawTables);

      // Por defecto, pre-seleccionar tablas que no sean "1" (política base)
      const initialSelected = new Set<string>();
      rawTables.forEach((t) => {
        if (t !== '1') {
          initialSelected.add(t);
        }
      });
      setSelectedTables(initialSelected);
    } catch (err: any) {
      setFetchError(err.message || 'Error de conexión con la API de VTEX');
    } finally {
      setLoadingTables(false);
    }
  };

  useEffect(() => {
    if (isOpen && selectedAccount) {
      fetchPriceTables();
    }
  }, [isOpen, selectedAccount?.id]);

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!isOpen) return null;

  const toggleTable = (tableId: string) => {
    const next = new Set(selectedTables);
    if (next.has(tableId)) {
      next.delete(tableId);
    } else {
      next.add(tableId);
    }
    setSelectedTables(next);
  };

  const selectAllTables = () => {
    setSelectedTables(new Set(tables));
  };

  const deselectAllTables = () => {
    setSelectedTables(new Set());
  };

  const handleStartCleanup = async () => {
    if (!selectedAccount) return;
    if (selectedTables.size === 0 && mode === 'auto') {
      alert('Debes seleccionar al menos una tabla de precios para limpiar.');
      return;
    }
    if (mode === 'file' && !selectedFile) {
      alert('Debes adjuntar un archivo Excel con las columnas [SKU ID, tabla de precios].');
      return;
    }

    setIsRunning(true);
    setLogs([]);
    setMetrics({ processed: 0, deleted: 0, errors: 0, skipped: 0 });

    addLog('info', `Iniciando proceso: LIMPIEZA DE PRECIOS (${isDryRun ? 'SIMULACIÓN' : 'PRODUCCIÓN'})`);
    addLog('info', `Cuenta: ${selectedAccount.account_name} | Modo: ${mode === 'auto' ? 'Catálogo Completo' : 'Por Archivo'}`);
    addLog('info', `Tablas seleccionadas: [${Array.from(selectedTables).join(', ')}]`);

    try {
      const formData = new FormData();
      formData.append('accountId', selectedAccount.id);
      formData.append('tables', Array.from(selectedTables).join(','));
      formData.append('dryRun', isDryRun ? 'true' : 'false');
      if (mode === 'file' && selectedFile) {
        formData.append('file', selectedFile);
      }

      const res = await fetch('/api/pricing/cleanup', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson.error || `HTTP ${res.status}: Error al iniciar limpieza`);
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
                  deleted: event.meta.created || 0,
                  errors: event.meta.errors || 0,
                  skipped: event.meta.skipped || 0,
                });
              }
            } else if (event.type === 'complete') {
              if (event.meta?.exitCode === 0) {
                addLog('success', isDryRun ? '🏆 Simulación de limpieza completada con éxito.' : '🎉 Limpieza de listas de precios ejecutada exitosamente en VTEX.');
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

  const hasBasePolicySelected = selectedTables.has('1');

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white shadow-md shadow-rose-950/50">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-base text-slate-100">Full Clean Up: Listas de Precios</h3>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-rose-950/60 text-rose-400 border border-rose-800/60">
                  Fixed Prices Purge
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Eliminación selectiva o total de listas de precios residuales en{' '}
                <span className="font-semibold text-rose-300">{selectedAccount?.account_name || 'cuenta VTEX'}</span>
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
              <p className="font-medium text-amber-300">Arquitectura de Precios en VTEX:</p>
              <p className="mt-0.5 text-slate-400 leading-relaxed">
                Al ejecutar esta limpieza, se eliminan todos los precios fijos asociados a los SKUs (<code className="text-amber-300 font-mono">DELETE /pricing/prices/{'{sku}'}/fixed/{'{tabla}'}</code>). Al quedar en <b>0 precios</b>, la tabla queda <b>completamente inerte y ya no altera los precios</b> de la tienda ni en vitrinas ni en checkout.
              </p>
              <p className="mt-1 text-slate-500 text-[11px]">
                ℹ️ Por políticas internas de seguridad de VTEX, el identificador/nombre de la tabla permanece en el listado del Admin hasta que se solicite su eliminación definitiva a <b>Soporte VTEX</b> (requiere que la tabla esté previamente vaciada, tal como lo hace este módulo).
              </p>
            </div>
          </div>

          {/* Selector de Modo */}
          <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-1.5 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => setMode('auto')}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-medium text-xs transition-all ${
                mode === 'auto'
                  ? 'bg-rose-950/50 border border-rose-500/50 text-rose-200 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Layers className="h-4 w-4" />
              <span>Automático (Todo el Catálogo)</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-medium text-xs transition-all ${
                mode === 'file'
                  ? 'bg-rose-950/50 border border-rose-500/50 text-rose-200 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>Por Planilla Excel (Opcional)</span>
            </button>
          </div>

          {/* Subida de archivo si el modo es file */}
          {mode === 'file' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <div>
                  <span className="text-xs font-semibold text-slate-200">Planilla personalizada de SKUs</span>
                  <p className="text-[11px] text-slate-400">
                    Sube un archivo Excel para eliminar únicamente los precios fijos indicados.
                  </p>
                </div>
                <a
                  href="/templates/Planilla_de_eliminacion_de_precios_por_SKU.xlsx"
                  download="Planilla_de_eliminacion_de_precios_por_SKU.xlsx"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/60 hover:border-rose-500/80 transition-all shadow-sm cursor-pointer"
                  title="Descargar plantilla de Excel de ejemplo"
                >
                  <Download className="h-3.5 w-3.5 text-rose-400" />
                  <span>Descargar Template Excel</span>
                </a>
              </div>

              <div className="border-2 border-dashed border-slate-700 hover:border-rose-500/50 bg-slate-950/40 rounded-xl p-4 transition-all">
                <label className="flex flex-col items-center justify-center cursor-pointer">
                  <UploadCloud className="h-8 w-8 text-rose-400 mb-2" />
                  <span className="text-xs font-semibold text-slate-200">
                    {selectedFile ? selectedFile.name : 'Haz clic para seleccionar el Excel de precios'}
                  </span>
                  <span className="text-[11px] text-slate-500 mt-1">
                    Columnas requeridas: <b>SKU ID</b> y opcionalmente <b>tabla de precios</b>
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
                      Archivo seleccionado: <b className="text-rose-300">{selectedFile.name}</b> ({(selectedFile.size / 1024).toFixed(1)} KB)
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

          {/* Sección de Tablas de Precios Descubiertas */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Listas de Precios detectadas en VTEX:
                </span>
                {loadingTables && (
                  <span className="text-[11px] text-slate-500 flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Consultando...
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={fetchPriceTables}
                  disabled={loadingTables || isRunning}
                  className="text-xs text-slate-400 hover:text-slate-200 p-1 hover:bg-slate-800 rounded transition-colors"
                  title="Recargar tablas"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingTables ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={selectAllTables}
                  disabled={loadingTables || tables.length === 0}
                  className="text-[11px] text-rose-400 hover:text-rose-300 font-semibold px-2 py-0.5 rounded bg-rose-950/30 hover:bg-rose-950/60 border border-rose-800/40 transition-colors"
                >
                  Seleccionar todas
                </button>
                <button
                  type="button"
                  onClick={deselectAllTables}
                  disabled={loadingTables || tables.length === 0}
                  className="text-[11px] text-slate-400 hover:text-slate-300 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
                >
                  Deseleccionar todas
                </button>
              </div>
            </div>

            {fetchError ? (
              <div className="p-3 bg-red-950/30 border border-red-800/50 rounded-lg text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0" />
                <span>{fetchError}</span>
              </div>
            ) : tables.length === 0 && !loadingTables ? (
              <p className="text-xs text-slate-500 py-3 text-center">
                No se encontraron listas de precios registradas en esta cuenta.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {tables.map((tableId) => {
                  const isChecked = selectedTables.has(tableId);
                  const isBase = tableId === '1';

                  return (
                    <div
                      key={tableId}
                      onClick={() => toggleTable(tableId)}
                      className={`cursor-pointer rounded-lg p-2.5 border transition-all flex items-center justify-between ${
                        isChecked
                          ? isBase
                            ? 'bg-amber-950/40 border-amber-500/70 text-amber-200 shadow-sm'
                            : 'bg-rose-950/40 border-rose-500/70 text-rose-100 shadow-sm'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}} // controlado por onClick del padre
                          className="rounded border-slate-700 text-rose-600 focus:ring-rose-500/40 bg-slate-800 cursor-pointer"
                        />
                        <span className="font-mono text-xs font-semibold truncate">{tableId}</span>
                      </div>
                      {isBase && (
                        <span
                          className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-700/50 flex items-center gap-1"
                          title="Política comercial principal de la tienda"
                        >
                          <ShieldAlert className="h-2.5 w-2.5" /> Base
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {hasBasePolicySelected && (
              <div className="mt-3 p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/60 flex items-center gap-2 text-xs text-amber-300">
                <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
                <span>
                  <b>¡Cuidado!</b> Has seleccionado la tabla <code>&quot;1&quot;</code> (Política Principal). Al limpiarla se borrarán los precios base fijos de todos los productos de tu tienda.
                </span>
              </div>
            )}
          </div>

          {/* Toggle Dry-Run vs Producción */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/80 border border-slate-800">
            <div>
              <span className="text-xs font-semibold text-slate-200 block">Modo de Operación:</span>
              <span className="text-[11px] text-slate-400">
                {isDryRun
                  ? 'Simulación segura (Dry-Run): Identifica SKUs con precios fijos sin borrarlos.'
                  : '⚠️ Modo Carga Real: Los precios fijos serán eliminados definitivamente en VTEX.'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsDryRun(true)}
                disabled={isRunning}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
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
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  !isDryRun
                    ? 'bg-rose-600 text-white shadow-md shadow-rose-950/50 font-bold'
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
                <Terminal className="h-3.5 w-3.5 text-rose-400" />
                Terminal de Salida en Tiempo Real
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded bg-slate-800 border-slate-700 text-rose-500"
                  />
                  Auto-scroll
                </label>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
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
            {selectedTables.size > 0 ? (
              <span>
                <b>{selectedTables.size}</b> tabla(s) seleccionada(s) para limpieza.
              </span>
            ) : (
              <span className="text-amber-400">Ninguna tabla seleccionada.</span>
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
              disabled={isRunning || (selectedTables.size === 0 && mode === 'auto')}
              className={`flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isDryRun
                  ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-950/40'
                  : 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/50'
              }`}
            >
              {isRunning ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>Procesando...</span>
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  <span>{isDryRun ? 'Iniciar Simulación (Dry-Run)' : 'Ejecutar Eliminación en VTEX'}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
