'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Images,
  ImageMinus,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Terminal,
  FileSpreadsheet,
  Info,
  X,
  Layers,
  UploadCloud,
  Flame,
  CopyCheck,
  Search,
  Sparkles,
  ShieldAlert,
  Hash,
  Lock,
} from 'lucide-react';
import { VtexAccount } from '@/types/database';

interface ImagesCleanupModalProps {
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

export default function ImagesCleanupModal({
  isOpen,
  onClose,
  selectedAccount,
}: ImagesCleanupModalProps) {
  // Modo de operación: 'duplicate' (conservar original y eliminar copias) vs 'purge' (borrar todas)
  const [operationMode, setOperationMode] = useState<'duplicate' | 'purge'>('duplicate');

  // Origen de SKUs: 'auto' (todo el catálogo), 'file' (Excel/CSV/TXT), 'manual' (lista separada por coma)
  const [targetSource, setTargetSource] = useState<'auto' | 'file' | 'manual'>('auto');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [manualSkus, setManualSkus] = useState<string>('');

  // Confirmación destructiva para Live Purge
  const [confirmPurgeText, setConfirmPurgeText] = useState('');
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Validación previa de Dry-Run requerida para Producción
  const [isDryRunPassed, setIsDryRunPassed] = useState<boolean>(false);

  // Ejecución
  const [isDryRun, setIsDryRun] = useState<boolean>(true);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progressData, setProgressData] = useState<{ current: number; total: number; percentage: number } | null>(null);

  // Resetear validación de Dry-Run ante cualquier cambio de configuración
  useEffect(() => {
    setIsDryRunPassed(false);
  }, [operationMode, targetSource, selectedFile, manualSkus, selectedAccount?.id, isOpen]);

  // Terminal & Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [metrics, setMetrics] = useState({ processed: 0, created: 0, updated: 0, errors: 0, skipped: 0 });
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

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!isOpen) return null;

  const handleStartCleanup = async (dryRunOverride?: boolean) => {
    const runAsDry = dryRunOverride !== undefined ? dryRunOverride : isDryRun;
    if (!selectedAccount) {
      addLog('error', 'Seleccione una cuenta de VTEX válida antes de continuar.');
      return;
    }

    if (!runAsDry && !isDryRunPassed) {
      addLog('error', '⚠️ Acción bloqueada: Debes ejecutar y validar primero la Simulación (Dry-Run) antes de aplicar cambios en Producción.');
      return;
    }

    if (targetSource === 'file' && !selectedFile) {
      addLog('error', 'Debe seleccionar un archivo (.xlsx, .csv o .txt) para continuar.');
      return;
    }

    if (targetSource === 'manual' && !manualSkus.trim()) {
      addLog('error', 'Debe ingresar al menos un SKU ID para continuar en modo manual.');
      return;
    }

    setIsRunning(true);
    setIsDryRun(runAsDry);
    setProgressData(null);
    setLogs([]);
    setMetrics({ processed: 0, created: 0, updated: 0, errors: 0, skipped: 0 });

    const modeTitle = operationMode === 'purge' ? 'PURGA TOTAL (ELIMINAR TODAS)' : 'LIMPIEZA DE DUPLICADOS';
    addLog(
      'info',
      `🚀 Iniciando Limpieza de Imágenes (${runAsDry ? 'SIMULACIÓN DRY-RUN' : 'PRODUCCIÓN'}) - [${modeTitle}]`
    );
    addLog(
      'info',
      `Cuenta: ${selectedAccount.account_name} | Origen: ${
        targetSource === 'auto'
          ? 'Catálogo Completo'
          : targetSource === 'file'
          ? `Archivo (${selectedFile?.name})`
          : `Manual (${manualSkus})`
      }`
    );

    if (operationMode === 'purge' && !runAsDry) {
      addLog('warning', '⚠️ MODO DESTRUCTIVO: Se eliminarán de forma irreversible todas las imágenes de los SKUs procesados.');
    }

    try {
      const formData = new FormData();
      formData.append('accountId', selectedAccount.id);
      formData.append('dryRun', runAsDry ? 'true' : 'false');
      formData.append('deleteAll', operationMode === 'purge' ? 'true' : 'false');

      if (targetSource === 'manual' && manualSkus.trim()) {
        formData.append('skus', manualSkus.trim());
      } else if (targetSource === 'file' && selectedFile) {
        formData.append('file', selectedFile);
      }

      const res = await fetch('/api/images/cleanup', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson.error || `HTTP ${res.status}: Error al iniciar limpieza de imágenes`);
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

            if (event.type === 'progress' && event.meta) {
              setProgressData({
                current: event.meta.current,
                total: event.meta.total,
                percentage: event.meta.percentage,
              });
              addLog('progress', event.message);
            } else if (event.type === 'summary') {
              addLog('summary', event.message);
              if (event.meta) {
                setMetrics({
                  processed: event.meta.processed || 0,
                  created: event.meta.created || 0,
                  updated: event.meta.updated || 0,
                  errors: event.meta.errors || 0,
                  skipped: event.meta.skipped || 0,
                });
              }
            } else if (event.type === 'complete') {
              if (event.meta?.exitCode === 0) {
                if (runAsDry) {
                  setIsDryRunPassed(true);
                  addLog(
                    'success',
                    '🏆 Simulación completada con éxito. La opción de Carga en Producción ha sido desbloqueada.'
                  );
                } else {
                  setIsDryRunPassed(false);
                  addLog(
                    'success',
                    '🎉 Limpieza de imágenes en VTEX ejecutada con éxito.'
                  );
                }
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
      <div className="bg-slate-900 border border-purple-500/30 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl flex items-center justify-center text-white shadow-md bg-gradient-to-tr from-purple-600 to-indigo-600 shadow-purple-950/50">
              <Images className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-base text-slate-100">
                  Limpieza y Gestión de Imágenes
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  VTEX Catalog
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Eliminación de imágenes duplicadas o purga total por SKU en cuenta{' '}
                <span className="text-slate-200 font-medium">
                  {selectedAccount?.account_name || 'No seleccionada'}
                </span>
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={isRunning}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 1. Selector de Modo de Operación */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-purple-400" />
              1. Modo de Operación
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Opción 1: Duplicados */}
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setOperationMode('duplicate')}
                className={`p-4 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                  operationMode === 'duplicate'
                    ? 'border-purple-500/60 bg-purple-950/20 shadow-md shadow-purple-950/40 ring-1 ring-purple-500/30'
                    : 'border-slate-800 bg-slate-900/50 hover:bg-slate-800/40 text-slate-400'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold text-sm flex items-center gap-2 text-slate-100">
                      <CopyCheck className="h-4 w-4 text-purple-400" />
                      Limpieza de Duplicados
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      Recomendado
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Detecta imágenes repetidas por SKU. <strong>Conserva la original/principal (IsMain)</strong> y elimina únicamente las copias redundantes.
                  </p>
                </div>
              </button>

              {/* Opción 2: Purga Total */}
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setOperationMode('purge')}
                className={`p-4 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                  operationMode === 'purge'
                    ? 'border-rose-500/60 bg-rose-950/20 shadow-md shadow-rose-950/40 ring-1 ring-rose-500/30'
                    : 'border-slate-800 bg-slate-900/50 hover:bg-slate-800/40 text-slate-400'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold text-sm flex items-center gap-2 text-slate-100">
                      <Flame className="h-4 w-4 text-rose-400" />
                      Purga Total
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      Destructivo
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Elimina el <strong>100% de las imágenes</strong> asociadas a cada SKU procesado. Ideal para corregir cruces masivos erróneos o rehacer fotografías.
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* 2. Origen de SKUs */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Layers className="h-3.5 w-3.5 text-purple-400" />
              2. Selección de SKUs Objetivo
            </label>
            <div className="grid grid-cols-3 gap-2 p-1 bg-slate-950/60 border border-slate-800 rounded-xl">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setTargetSource('auto')}
                className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-2 ${
                  targetSource === 'auto'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Catálogo Completo
              </button>

              <button
                type="button"
                disabled={isRunning}
                onClick={() => setTargetSource('file')}
                className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-2 ${
                  targetSource === 'file'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Planilla (Excel / CSV / TXT)
              </button>

              <button
                type="button"
                disabled={isRunning}
                onClick={() => setTargetSource('manual')}
                className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-2 ${
                  targetSource === 'manual'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Hash className="h-3.5 w-3.5" />
                SKU(s) Manual
              </button>
            </div>

            {/* Panel Condicional: Archivo */}
            {targetSource === 'file' && (
              <div className="p-4 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 text-center space-y-2 animate-in fade-in duration-150">
                <input
                  type="file"
                  id="images-file-input"
                  accept=".xlsx,.xls,.csv,.txt"
                  disabled={isRunning}
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      setSelectedFile(e.target.files[0]);
                    }
                  }}
                  className="hidden"
                />
                <label
                  htmlFor="images-file-input"
                  className="cursor-pointer flex flex-col items-center justify-center gap-1.5"
                >
                  <UploadCloud className="h-7 w-7 text-purple-400" />
                  <span className="text-xs font-semibold text-slate-200">
                    {selectedFile ? selectedFile.name : 'Haz clic para seleccionar o arrastra una planilla'}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Soporta Excel (.xlsx), CSV (.csv) o TXT con columna de SKU IDs
                  </span>
                </label>
              </div>
            )}

            {/* Panel Condicional: Manual */}
            {targetSource === 'manual' && (
              <div className="space-y-1.5 p-3 rounded-xl border border-slate-800 bg-slate-950/40 animate-in fade-in duration-150">
                <label className="text-[11px] font-medium text-slate-400">
                  Ingresa uno o varios SKU IDs separados por coma o salto de línea:
                </label>
                <textarea
                  rows={2}
                  disabled={isRunning}
                  value={manualSkus}
                  onChange={(e) => setManualSkus(e.target.value)}
                  placeholder="Ej: 1024, 1852, 2300, 4511"
                  className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-slate-200 font-mono placeholder:text-slate-600 focus:outline-none focus:border-purple-500 resize-none"
                />
              </div>
            )}
          </div>

          {/* 3. Métricas y Barra de Progreso */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3">
              <span className="text-[11px] text-slate-400 font-medium">Imágenes Encontradas</span>
              <p className="text-lg font-bold text-slate-100">{metrics.processed.toLocaleString()}</p>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3">
              <span className="text-[11px] text-purple-400 font-medium">Conservadas (Únicas)</span>
              <p className="text-lg font-bold text-purple-300">{metrics.skipped.toLocaleString()}</p>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3">
              <span className="text-[11px] text-amber-400 font-medium">
                {isDryRun ? 'A Eliminar (Simulado)' : 'Eliminadas (VTEX)'}
              </span>
              <p className="text-lg font-bold text-amber-300">{metrics.updated.toLocaleString()}</p>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3">
              <span className="text-[11px] text-rose-400 font-medium">Errores</span>
              <p className="text-lg font-bold text-rose-400">{metrics.errors.toLocaleString()}</p>
            </div>
          </div>

          {/* Barra de progreso */}
          {progressData && (
            <div className="space-y-1.5 bg-slate-950/40 p-3 rounded-xl border border-slate-800">
              <div className="flex justify-between text-xs font-semibold">
                <span className="text-slate-300">Progreso de ejecución</span>
                <span className="text-purple-400">{progressData.percentage}% ({progressData.current} / {progressData.total})</span>
              </div>
              <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-200"
                  style={{ width: `${progressData.percentage}%` }}
                />
              </div>
            </div>
          )}

          {/* 4. Terminal en Vivo */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span className="flex items-center gap-1.5 text-slate-300">
                <Terminal className="h-3.5 w-3.5 text-purple-400" />
                Consola de Streaming en Tiempo Real
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer text-[11px]">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-purple-600 focus:ring-0"
                  />
                  Auto-scroll
                </label>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="hover:text-slate-200 transition-colors text-[11px]"
                >
                  Limpiar
                </button>
              </div>
            </div>

            <div
              ref={terminalRef}
              className="bg-black/90 border border-slate-800/90 rounded-xl p-3 h-48 overflow-y-auto font-mono text-xs text-slate-300 space-y-1 select-text shadow-inner"
            >
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-600 text-[11px]">
                  La consola está lista. Selecciona las opciones y ejecuta una Simulación o Carga en Producción.
                </div>
              ) : (
                logs.map((log) => {
                  let color = 'text-slate-300';
                  if (log.type === 'error') color = 'text-rose-400 font-semibold';
                  else if (log.type === 'warning') color = 'text-amber-400';
                  else if (log.type === 'success') color = 'text-emerald-400 font-semibold';
                  else if (log.type === 'progress') color = 'text-sky-300';
                  else if (log.type === 'summary') color = 'text-purple-300 font-bold';

                  return (
                    <div key={log.id} className="leading-tight flex items-start gap-2">
                      <span className="text-slate-600 select-none text-[10px] shrink-0 font-sans">
                        {log.timestamp}
                      </span>
                      <span className={`break-all ${color}`}>{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/60 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            {isDryRunPassed ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 animate-in fade-in">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                Simulación validada: Producción desbloqueada
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-slate-400 text-xs">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                <span>
                  {operationMode === 'purge'
                    ? 'Requiere simulación previa (Dry-Run) antes de purgar.'
                    : 'Requiere simulación previa (Dry-Run) antes de limpiar.'}
                </span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            {/* Botón Simular (Dry-Run) */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() => handleStartCleanup(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer shadow-sm"
            >
              <Search className="h-3.5 w-3.5 text-purple-400" />
              {isRunning && isDryRun ? 'Simulando...' : 'Simular Limpieza (Dry-Run)'}
            </button>

            {/* Botón Producción (Bloqueado hasta validar Dry-Run) */}
            <button
              type="button"
              disabled={!isDryRunPassed || isRunning}
              onClick={() => {
                if (!isDryRunPassed) return;
                if (operationMode === 'purge') {
                  setShowConfirmModal(true);
                  setConfirmPurgeText('');
                } else {
                  if (confirm('¿Confirmas la eliminación definitiva de las imágenes duplicadas en VTEX?')) {
                    handleStartCleanup(false);
                  }
                }
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow-md ${
                !isDryRunPassed || isRunning
                  ? 'bg-slate-800/60 text-slate-500 border border-slate-700/50 cursor-not-allowed opacity-50 shadow-none'
                  : operationMode === 'purge'
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/50 cursor-pointer ring-2 ring-rose-500/40'
                  : 'bg-purple-600 hover:bg-purple-500 text-white shadow-purple-950/50 cursor-pointer ring-2 ring-purple-500/40'
              }`}
              title={
                !isDryRunPassed
                  ? 'Debes ejecutar y validar primero la Simulación (Dry-Run)'
                  : operationMode === 'purge'
                  ? 'Ejecutar Purga Total en Producción'
                  : 'Limpiar Duplicados en Producción'
              }
            >
              {!isDryRunPassed ? (
                <Lock className="h-3.5 w-3.5 text-slate-500" />
              ) : (
                <ImageMinus className="h-3.5 w-3.5" />
              )}
              {isRunning && !isDryRun
                ? 'Ejecutando...'
                : !isDryRunPassed
                ? 'Producción (Bloqueado)'
                : operationMode === 'purge'
                ? 'Ejecutar Purga Total (Live)'
                : 'Limpiar Duplicados en Producción'}
            </button>
          </div>
        </div>
      </div>

      {/* Modal de confirmación para Purga Total */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-60 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-rose-500/50 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20">
                <ShieldAlert className="h-6 w-6" />
              </div>
              <div>
                <h4 className="font-bold text-slate-100 text-sm">Confirmar Purga Total</h4>
                <p className="text-xs text-rose-400/90 font-medium">Esta acción eliminará todas las imágenes de los SKUs</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Estás a punto de borrar <strong>todas las fotografías</strong> de los SKUs en la cuenta{' '}
              <span className="text-slate-100 font-bold">{selectedAccount?.account_name}</span>. Para autorizar la operación, escribe <code className="bg-rose-950/50 px-1.5 py-0.5 rounded border border-rose-500/30 text-rose-300 font-bold font-mono">PURGAR</code> a continuación:
            </p>

            <input
              type="text"
              value={confirmPurgeText}
              onChange={(e) => setConfirmPurgeText(e.target.value)}
              placeholder="Escribe PURGAR para confirmar"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-rose-500"
            />

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={confirmPurgeText.trim().toUpperCase() !== 'PURGAR'}
                onClick={() => {
                  setShowConfirmModal(false);
                  handleStartCleanup(false);
                }}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-40 transition-colors shadow-sm"
              >
                Confirmar y Purgar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
