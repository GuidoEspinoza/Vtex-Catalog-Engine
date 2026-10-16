'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  UploadCloud,
  Layers,
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileSpreadsheet,
  Terminal,
  PlusCircle,
  Sparkles,
  LogOut,
  RefreshCw,
  FolderTree,
  Tag,
  ListPlus,
  Sliders,
  PackageCheck,
  FolderArchive,
  Info,
  Trash2,
  Download,
} from 'lucide-react';
import { VtexAccount } from '@/types/database';
import PriceCleanupModal from '@/components/PriceCleanupModal';

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'stdout' | 'stderr' | 'info' | 'warning' | 'error' | 'success' | 'progress' | 'summary';
  message: string;
}

interface GeminiAnalysis {
  valid: boolean;
  confidenceScore: number;
  detectedEntity: string;
  headerMapping: Record<string, string>;
  missingRequired: string[];
  warnings: string[];
  recommendations: string[];
}

const ENTITIES = [
  {
    id: 'categories',
    label: 'Árbol de Categorías',
    icon: FolderTree,
    desc: 'Departamentos, categorías y subcategorías',
    templateUrl: '/templates/Planilla_de_Categorias.xlsx',
    templateName: 'Planilla_de_Categorias.xlsx',
  },
  {
    id: 'brands',
    label: 'Marcas',
    icon: Tag,
    desc: 'Catálogo de marcas y metadatos SEO',
    templateUrl: '/templates/Planilla_de_Marcas.xlsx',
    templateName: 'Planilla_de_Marcas.xlsx',
  },
  {
    id: 'specifications',
    label: 'Campos y Grupos',
    icon: Sliders,
    desc: 'Especificaciones de Producto y SKU',
    templateUrl: '/templates/Planilla_de_Especificaciones.xlsx',
    templateName: 'Planilla_de_Especificaciones.xlsx',
  },
  {
    id: 'spec_values',
    label: 'Valores de Atributos',
    icon: ListPlus,
    desc: 'Opciones predefinidas de combos/radios',
    templateUrl: '/templates/Planilla_de_Opciones_Especificaciones.xlsx',
    templateName: 'Planilla_de_Opciones_Especificaciones.xlsx',
  },
  {
    id: 'product_specs',
    label: 'Asignación a Productos',
    icon: PackageCheck,
    desc: 'Valores asignados a IDs de producto',
    templateUrl: '/templates/Planilla_de_Asignacion_Atributos_Productos.xlsx',
    templateName: 'Planilla_de_Asignacion_Atributos_Productos.xlsx',
  },
  {
    id: 'collections',
    label: 'Colecciones',
    icon: FolderArchive,
    desc: 'Colecciones dinámicas y subcolecciones',
    templateUrl: '/templates/Planilla_de_Colecciones.xlsx',
    templateName: 'Planilla_de_Colecciones.xlsx',
  },
];

export default function CatalogEngineDashboard() {
  const router = useRouter();

  // Estados de Cuentas
  const [accounts, setAccounts] = useState<VtexAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [showNewAccountModal, setShowNewAccountModal] = useState(false);
  const [showPriceCleanupModal, setShowPriceCleanupModal] = useState(false);

  // Formulario nueva cuenta
  const [newAccount, setNewAccount] = useState({
    company_name: '',
    account_name: '',
    environment: 'vtexcommercestable',
    app_key: '',
    app_token: '',
  });
  const [savingAccount, setSavingAccount] = useState(false);

  // Estados de Entidad y Archivo
  const [selectedEntity, setSelectedEntity] = useState<string>('categories');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Asistente Gemini AI
  const [analyzingAi, setAnalyzingAi] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<GeminiAnalysis | null>(null);

  // Flujo de Ejecución (Dry-Run & Live)
  const [isDryRunPassed, setIsDryRunPassed] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [activeMode, setActiveMode] = useState<'dry_run' | 'live' | null>(null);
  const [progressData, setProgressData] = useState<{ current: number; total: number; percentage: number } | null>(null);

  // Consola de Logs y Métricas
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [metrics, setMetrics] = useState({ created: 0, updated: 0, errors: 0, skipped: 0 });
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const terminalBodyRef = useRef<HTMLDivElement>(null);

  // Cargar cuentas al inicio
  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const res = await fetch('/api/accounts');
      const json = await res.json();
      if (json.data && Array.isArray(json.data)) {
        setAccounts(json.data);
        if (json.data.length > 0 && !selectedAccountId) {
          setSelectedAccountId(json.data[0].id);
        }
      }
    } catch {
      addLog('error', 'Fallo al consultar las cuentas registradas en Supabase.');
    } finally {
      setLoadingAccounts(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    if (autoScroll && terminalBodyRef.current) {
      terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const addLog = (type: LogEntry['type'], message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [
      ...prev,
      { id: Math.random().toString(36).substring(7), timestamp, type, message },
    ]);
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAccount(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAccount),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error guardando cuenta');

      addLog('success', `Cuenta '${newAccount.company_name}' registrada exitosamente en Supabase.`);
      setShowNewAccountModal(false);
      setNewAccount({ company_name: '', account_name: '', environment: 'vtexcommercestable', app_key: '', app_token: '' });
      await fetchAccounts();
      if (data.data?.id) setSelectedAccountId(data.data.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('error', `Error al crear cuenta: ${msg}`);
    } finally {
      setSavingAccount(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  const handleFileSelection = (file: File) => {
    setSelectedFile(file);
    setIsDryRunPassed(false);
    setAiAnalysis(null);
    setProgressData(null);
    setMetrics({ created: 0, updated: 0, errors: 0, skipped: 0 });
    addLog('info', `Planilla cargada: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
  };

  // Análisis inteligente con Gemini
  const runGeminiAnalysis = async () => {
    if (!selectedFile) return;

    setAnalyzingAi(true);
    addLog('info', `Consultando asistente Gemini AI para validación semántica de '${selectedFile.name}'...`);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('entity', selectedEntity);

      const res = await fetch('/api/ai/validate', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fallo en la respuesta de Gemini');

      setAiAnalysis(data.analysis);
      addLog('success', `Validación semántica con ${data.model || 'Gemini 3.8 Flash'} completada (Confianza: ${data.analysis.confidenceScore ?? 95}%).`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('warning', `Aviso de análisis Gemini: ${msg}`);
    } finally {
      setAnalyzingAi(false);
    }
  };

  // Ejecución (Dry-Run o Producción)
  const executeProcess = async (isDryRun: boolean) => {
    if (!selectedFile || !selectedAccountId) return;

    setIsRunning(true);
    setActiveMode(isDryRun ? 'dry_run' : 'live');
    setProgressData(null);

    const modeName = isDryRun ? 'SIMULACIÓN (DRY-RUN)' : 'CARGA EN VIVO (PRODUCCIÓN)';
    addLog('info', `=====================================================`);
    addLog('info', `Iniciando proceso: ${modeName}`);
    addLog('info', `Entidad: ${selectedEntity.toUpperCase()} | Archivo: ${selectedFile.name}`);
    addLog('info', `=====================================================`);

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('entity', selectedEntity);
    formData.append('accountId', selectedAccountId);
    formData.append('dryRun', isDryRun ? 'true' : 'false');

    try {
      const response = await fetch('/api/scripts/execute', {
        method: 'POST',
        body: formData,
      });

      if (!response.body) throw new Error('No se pudo establecer el stream de Server-Sent Events');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.replace('data: ', ''));

            if (event.type === 'progress') {
              addLog('progress', event.message);
              if (event.meta?.percentage !== undefined) {
                setProgressData({
                  current: event.meta.current,
                  total: event.meta.total,
                  percentage: event.meta.percentage,
                });
              }
            } else if (event.type === 'summary') {
              addLog('success', event.message);
              if (event.meta) {
                setMetrics({
                  created: event.meta.created || 0,
                  updated: event.meta.updated || 0,
                  errors: event.meta.errors || 0,
                  skipped: event.meta.skipped || 0,
                });
              }
            } else if (event.type === 'complete') {
              if (event.meta?.exitCode === 0) {
                if (isDryRun) {
                  setIsDryRunPassed(true);
                  addLog('success', '🏆 Simulación Dry-Run aprobada sin errores bloqueantes. Se ha desbloqueado la Carga Real.');
                } else {
                  addLog('success', '🎉 Carga en producción concluida exitosamente en el catálogo VTEX.');
                }
              } else {
                addLog('error', `Proceso terminado con código de error ${event.meta?.exitCode}.`);
              }
            } else {
              addLog(event.type || 'stdout', event.message);
            }
          } catch {
            // Línea no parseable
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('error', `Fallo de comunicación: ${msg}`);
    } finally {
      setIsRunning(false);
      setActiveMode(null);
    }
  };

  const selectedAccountObj = accounts.find((a) => a.id === selectedAccountId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md px-8 py-4 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-pink-600 to-rose-400 flex items-center justify-center font-extrabold text-white shadow-lg shadow-pink-500/20">
            V
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg leading-tight tracking-tight">VTEX Catalog Engine</h1>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-pink-950/60 text-pink-400 border border-pink-800/60">
                Next.js 16 + Python
              </span>
            </div>
            <p className="text-xs text-slate-400">Plataforma interactiva de ingesta y simulación masiva</p>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-3">
          {/* Account selector */}
          <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 rounded-xl px-3 py-1.5 shadow-inner">
            <span className="text-xs text-slate-400 font-medium">Cuenta VTEX:</span>
            {loadingAccounts ? (
              <span className="text-xs text-slate-500">Cargando cuentas...</span>
            ) : accounts.length === 0 ? (
              <span className="text-xs text-amber-400">Sin cuentas registradas</span>
            ) : (
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="bg-transparent text-sm font-semibold text-slate-200 focus:outline-none cursor-pointer"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id} className="bg-slate-900 text-slate-200">
                    {acc.company_name} ({acc.account_name})
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => setShowNewAccountModal(true)}
              className="text-pink-400 hover:text-pink-300 ml-1 p-1 hover:bg-slate-800 rounded transition-colors"
              title="Registrar nueva cuenta VTEX"
            >
              <PlusCircle className="h-4 w-4" />
            </button>
          </div>

          {/* Price Cleanup Button */}
          <button
            onClick={() => setShowPriceCleanupModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-rose-500/40 bg-rose-950/20 text-rose-300 hover:bg-rose-900/30 hover:border-rose-500/60 transition-all text-xs font-semibold shadow-sm cursor-pointer"
            title="Limpieza de listas de precios (Full Clean Up)"
          >
            <Trash2 className="h-3.5 w-3.5 text-rose-400" />
            <span className="hidden sm:inline">Limpieza de Precios</span>
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-xl border border-slate-800 transition-colors cursor-pointer"
            title="Cerrar sesión"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 max-w-[1700px] w-full mx-auto">
        {/* Left Column (5 Cols) */}
        <section className="lg:col-span-5 space-y-6">
          {/* 1. Selector de Entidad */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Layers className="h-4 w-4 text-pink-500" />
                1. Selección de Entidad del Catálogo
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {ENTITIES.map((ent) => {
                const Icon = ent.icon;
                const isSelected = selectedEntity === ent.id;
                return (
                  <button
                    key={ent.id}
                    onClick={() => {
                      setSelectedEntity(ent.id);
                      setIsDryRunPassed(false);
                      setAiAnalysis(null);
                    }}
                    className={`text-left p-3.5 rounded-xl border transition-all cursor-pointer relative group ${
                      isSelected
                        ? 'bg-pink-950/30 border-pink-500/80 text-pink-200 shadow-md shadow-pink-950/20'
                        : 'bg-slate-950/40 border-slate-800/80 hover:bg-slate-800/40 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 font-medium text-sm">
                        <Icon className={`h-4 w-4 ${isSelected ? 'text-pink-400' : 'text-slate-500'}`} />
                        <span>{ent.label}</span>
                      </div>
                      <a
                        href={ent.templateUrl}
                        download={ent.templateName}
                        onClick={(e) => e.stopPropagation()}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-pink-400 hover:bg-slate-800/80 rounded transition-all"
                        title={`Descargar template de ${ent.label}`}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </a>
                    </div>
                    <p className="text-[11px] text-slate-500 line-clamp-1">{ent.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Carga de Archivo (Dropzone) */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-pink-500" />
                2. Planilla de Datos (Excel / CSV)
              </h2>
              <div className="flex items-center gap-2">
                {(() => {
                  const currentEntity = ENTITIES.find((e) => e.id === selectedEntity) || ENTITIES[0];
                  return (
                    <a
                      href={currentEntity.templateUrl}
                      download={currentEntity.templateName}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-pink-950/40 hover:bg-pink-900/60 text-pink-300 border border-pink-800/60 hover:border-pink-500/80 transition-all shadow-sm cursor-pointer"
                      title={`Descargar planilla template para ${currentEntity.label}`}
                    >
                      <Download className="h-3.5 w-3.5 text-pink-400" />
                      <span className="hidden sm:inline">Descargar Template</span>
                      <span className="sm:hidden">Template</span>
                    </a>
                  );
                })()}
                {selectedFile && (
                  <button
                    onClick={() => setSelectedFile(null)}
                    className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1"
                  >
                    Quitar
                  </button>
                )}
              </div>
            </div>

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files?.[0]) handleFileSelection(e.dataTransfer.files[0]);
              }}
              onClick={() => document.getElementById('dropzone-input')?.click()}
              className="border-2 border-dashed border-slate-700/80 hover:border-pink-500/60 rounded-xl p-8 text-center transition-all cursor-pointer bg-slate-950/50 group"
            >
              <input
                id="dropzone-input"
                type="file"
                className="hidden"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  if (e.target.files?.[0]) handleFileSelection(e.target.files[0]);
                }}
              />
              <div className="flex flex-col items-center">
                <div className="h-12 w-12 rounded-2xl bg-slate-800/60 group-hover:bg-pink-950/40 group-hover:text-pink-400 text-slate-400 flex items-center justify-center transition-colors mb-3">
                  <UploadCloud className="h-6 w-6" />
                </div>
                {selectedFile ? (
                  <div>
                    <p className="font-semibold text-sm text-slate-200">{selectedFile.name}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {(selectedFile.size / 1024).toFixed(1)} KB • Clic para reemplazar
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-medium text-slate-300">
                      Arrastra la planilla aquí o haz clic para buscar
                    </p>
                    <p className="text-xs text-slate-500 mt-1">Archivos soportados: .xlsx, .xls y .csv</p>
                  </div>
                )}
              </div>
            </div>

            {/* Asistente Gemini AI */}
            {selectedFile && (
              <div className="pt-2 border-t border-slate-800/60">
                <button
                  onClick={runGeminiAnalysis}
                  disabled={analyzingAi}
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-indigo-950/40 hover:bg-indigo-900/40 border border-indigo-800/60 text-indigo-300 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                >
                  <Sparkles className={`h-4 w-4 ${analyzingAi ? 'animate-spin' : 'text-indigo-400'}`} />
                  {analyzingAi ? 'Analizando con Gemini...' : 'Validar Estructura con Gemini AI'}
                </button>

                {aiAnalysis && (
                  <div className="mt-3 p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-xs space-y-2">
                    <div className="flex items-center justify-between font-semibold">
                      <span className="text-slate-300">Diagnóstico Semántico:</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] ${
                          aiAnalysis.valid
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                            : 'bg-amber-950/80 text-amber-300 border border-amber-800'
                        }`}
                      >
                        {aiAnalysis.confidenceScore}% Confianza
                      </span>
                    </div>

                    {aiAnalysis.missingRequired?.length > 0 && (
                      <p className="text-red-400">
                        ⚠️ Columnas obligatorias ausentes: {aiAnalysis.missingRequired.join(', ')}
                      </p>
                    )}

                    {aiAnalysis.warnings?.map((w, i) => (
                      <p key={i} className="text-amber-300">
                        • {w}
                      </p>
                    ))}

                    {aiAnalysis.recommendations?.map((r, i) => (
                      <p key={i} className="text-slate-400">
                        💡 {r}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 3. Acciones de Ejecución (Dry-Run & Live) */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <Play className="h-4 w-4 text-pink-500" />
              3. Flujo Controlado de Ejecución
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <button
                disabled={!selectedFile || isRunning}
                onClick={() => executeProcess(true)}
                className={`py-3.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  isRunning && activeMode === 'dry_run'
                    ? 'bg-amber-600/50 text-amber-200 animate-pulse border border-amber-500'
                    : 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-950/40 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                <RefreshCw className={`h-4 w-4 ${isRunning && activeMode === 'dry_run' ? 'animate-spin' : ''}`} />
                <span>Simulación Dry-Run</span>
              </button>

              <button
                disabled={!isDryRunPassed || isRunning}
                onClick={() => executeProcess(false)}
                className={`py-3.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  !isDryRunPassed || isRunning
                    ? 'bg-slate-800/80 text-slate-500 border border-slate-700/50 cursor-not-allowed'
                    : 'bg-pink-600 hover:bg-pink-500 text-white shadow-lg shadow-pink-950/40 animate-pulse'
                }`}
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>Carga en Producción</span>
              </button>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 text-[11px] text-slate-400 flex items-start gap-2">
              <Info className="h-4 w-4 text-pink-400 shrink-0 mt-0.5" />
              <span>
                {isDryRunPassed
                  ? '✅ Dry-Run validado exitosamente. Ahora puedes confirmar la Carga en Producción.'
                  : 'Para proteger el catálogo de la tienda, la Carga Real se mantiene bloqueada hasta que completes una Simulación Dry-Run sin errores fatales.'}
              </span>
            </div>
          </div>
        </section>

        {/* Right Column (7 Cols): Terminal & Métricas */}
        <section className="lg:col-span-7 flex flex-col space-y-4">
          {/* Métricas en Vivo */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
              <span className="text-xs text-slate-500 block">Creados</span>
              <span className="text-xl font-bold text-emerald-400">{metrics.created}</span>
            </div>
            <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
              <span className="text-xs text-slate-500 block">Actualizados</span>
              <span className="text-xl font-bold text-cyan-400">{metrics.updated}</span>
            </div>
            <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
              <span className="text-xs text-slate-500 block">Errores</span>
              <span className="text-xl font-bold text-red-400">{metrics.errors}</span>
            </div>
            <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
              <span className="text-xs text-slate-500 block">Omitidos</span>
              <span className="text-xl font-bold text-amber-400">{metrics.skipped}</span>
            </div>
          </div>

          {/* Barra de Progreso */}
          {progressData && (
            <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl space-y-2">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Progreso: {progressData.current} de {progressData.total} registros</span>
                <span className="font-bold text-pink-400">{progressData.percentage}%</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                <div
                  className="bg-gradient-to-r from-pink-500 to-rose-400 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progressData.percentage}%` }}
                />
              </div>
            </div>
          )}

          {/* Terminal Console */}
          <div className="flex-1 flex flex-col bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl min-h-[500px]">
            {/* Terminal Header */}
            <div className="bg-slate-900 px-5 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-red-500/80 inline-block" />
                <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block" />
                <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block" />
                <span className="ml-2 text-xs font-mono text-slate-400 flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  stream_execution.log
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setAutoScroll((prev) => !prev)}
                  className={`text-[11px] px-2.5 py-1 rounded-md transition-colors cursor-pointer border ${
                    autoScroll
                      ? 'bg-pink-950/40 text-pink-300 border-pink-800/60'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
                  }`}
                  title="Activar o pausar auto-scroll en nuevos logs"
                >
                  Auto-scroll: {autoScroll ? 'ON' : 'PAUSADO'}
                </button>
                <button
                  onClick={() => setLogs([])}
                  className="text-xs text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                >
                  Limpiar Terminal
                </button>
              </div>
            </div>

            {/* Terminal Body */}
            <div
              ref={terminalBodyRef}
              className="flex-1 p-5 font-mono text-xs overflow-y-auto space-y-1 bg-slate-950/80 select-text max-h-[620px]"
            >
              {logs.length === 0 ? (
                <p className="text-slate-600 italic">
                  Terminal en espera. Selecciona una cuenta, una entidad y un archivo para iniciar la simulación.
                </p>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="flex gap-2.5 leading-relaxed">
                    <span className="text-slate-600 shrink-0 select-none">[{log.timestamp}]</span>
                    <span
                      className={
                        log.type === 'error'
                          ? 'text-red-400 font-semibold'
                          : log.type === 'success'
                          ? 'text-emerald-400 font-semibold'
                          : log.type === 'warning'
                          ? 'text-amber-300 font-medium'
                          : log.type === 'progress'
                          ? 'text-pink-300'
                          : log.type === 'info'
                          ? 'text-cyan-400'
                          : log.type === 'stderr'
                          ? 'text-rose-300'
                          : 'text-slate-300'
                      }
                    >
                      {log.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Modal Nueva Cuenta */}
      {showNewAccountModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">Registrar Nueva Cuenta VTEX</h3>
            <p className="text-xs text-slate-400 mb-6">
              Las credenciales se almacenan en Supabase y se inyectan dinámicamente en cada ejecución.
            </p>

            <form onSubmit={handleCreateAccount} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Nombre Descriptivo</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Distribuidora Central"
                  value={newAccount.company_name}
                  onChange={(e) => setNewAccount({ ...newAccount, company_name: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Account Name (Vendor)</label>
                  <input
                    type="text"
                    required
                    placeholder="ej: dtparts"
                    value={newAccount.account_name}
                    onChange={(e) => setNewAccount({ ...newAccount, account_name: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Ambiente</label>
                  <input
                    type="text"
                    required
                    value={newAccount.environment}
                    onChange={(e) => setNewAccount({ ...newAccount, environment: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">X-VTEX-API-AppKey</label>
                <input
                  type="text"
                  required
                  placeholder="vtexappkey-..."
                  value={newAccount.app_key}
                  onChange={(e) => setNewAccount({ ...newAccount, app_key: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">X-VTEX-API-AppToken</label>
                <input
                  type="password"
                  required
                  placeholder="AppToken secreto"
                  value={newAccount.app_token}
                  onChange={(e) => setNewAccount({ ...newAccount, app_token: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowNewAccountModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingAccount}
                  className="px-4 py-2 text-xs font-semibold bg-pink-600 hover:bg-pink-500 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  {savingAccount ? 'Guardando en Supabase...' : 'Guardar Cuenta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Price Cleanup Modal */}
      <PriceCleanupModal
        isOpen={showPriceCleanupModal}
        onClose={() => setShowPriceCleanupModal(false)}
        selectedAccount={selectedAccountObj}
      />
    </div>
  );
}
