'use client';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, ArrowRight, ShieldCheck, AlertCircle } from 'lucide-react';

function LoginForm() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get('redirect') || '/';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Credenciales inválidas');
      }

      router.push(redirectPath);
      router.refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-md">
      <div className="flex items-center gap-2 mb-6 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <ShieldCheck className="h-4 w-4 text-pink-500" />
        <span>Acceso Protegido por Token Maestro</span>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-950/40 border border-red-800/60 flex items-center gap-3 text-red-300 text-sm">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleLogin} className="space-y-5">
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-2">
            Contraseña Administrativa
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
              <Lock className="h-4 w-4" />
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Introduce la contraseña maestra..."
              className="w-full pl-10 pr-4 py-3 bg-slate-950/60 border border-slate-700/80 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-pink-500/80 focus:border-transparent transition-all placeholder:text-slate-600"
              autoFocus
              required
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 px-4 rounded-xl font-medium text-sm text-white bg-pink-600 hover:bg-pink-500 active:scale-[0.99] transition-all flex items-center justify-center gap-2 shadow-lg shadow-pink-600/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {loading ? (
            <span>Validando credenciales...</span>
          ) : (
            <>
              <span>Ingresar a la Plataforma</span>
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex h-16 w-16 rounded-2xl bg-gradient-to-tr from-pink-600 to-rose-400 items-center justify-center font-bold text-white shadow-xl shadow-pink-500/20 mb-4">
            <span className="text-3xl font-extrabold tracking-tight">V</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">VTEX Catalog Engine</h1>
          <p className="text-sm text-slate-400 mt-1">
            Acceso administrativo para ingesta masiva y simulación
          </p>
        </div>

        <Suspense fallback={<div className="text-center text-sm text-slate-500">Cargando acceso...</div>}>
          <LoginForm />
        </Suspense>

        {/* Footer info */}
        <p className="text-center text-xs text-slate-600 mt-6">
          VTEX Catalog Engine • Next.js 16 + Python Architecture
        </p>
      </div>
    </div>
  );
}
