'use client';

import React, { useState, useEffect } from 'react';
import {
  Users,
  UserPlus,
  Trash2,
  Shield,
  User,
  X,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Mail,
  KeyRound,
  Eye,
  EyeOff,
  Edit2,
} from 'lucide-react';
import { SessionUser } from '@/lib/auth';

interface AppUser {
  id: string;
  email: string;
  role: 'admin' | 'internal';
  created_at: string;
}

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: SessionUser | null;
}

export default function UserManagementModal({
  isOpen,
  onClose,
  currentUser,
}: UserManagementModalProps) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Formulario nuevo usuario
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'internal' | 'admin'>('internal');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Estado para resetear contraseña de usuario existente
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users');
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al obtener lista de usuarios');
      }
      setUsers(data.users || []);
    } catch (err: any) {
      setError(err.message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
      setError(null);
      setSuccessMsg(null);
      setNewEmail('');
      setNewPassword('');
      setEditingUserId(null);
      setResetPasswordVal('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    const emailTrimmed = newEmail.toLowerCase().trim();
    if (!emailTrimmed.endsWith('@nexitty.com')) {
      setError('El correo debe terminar estrictamente en @nexitty.com');
      return;
    }

    if (!newPassword || newPassword.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailTrimmed,
          role: newRole,
          password: newPassword,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al crear usuario');
      }

      setSuccessMsg(
        `Usuario ${emailTrimmed} agregado exitosamente con rol ${newRole === 'admin' ? 'Administrador' : 'Interno'}.`
      );
      setNewEmail('');
      setNewPassword('');
      setNewRole('internal');
      fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Error al registrar usuario');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async (user: AppUser) => {
    if (!resetPasswordVal || resetPasswordVal.length < 6) {
      setError('La nueva contraseña debe tener mínimo 6 caracteres');
      return;
    }

    setSavingPassword(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPasswordVal }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al actualizar contraseña');
      }

      setSuccessMsg(`Contraseña de ${user.email} actualizada con éxito.`);
      setEditingUserId(null);
      setResetPasswordVal('');
    } catch (err: any) {
      setError(err.message || 'Error al actualizar contraseña');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleRoleChange = async (user: AppUser, newRoleVal: 'admin' | 'internal') => {
    if (user.email.toLowerCase() === currentUser?.email.toLowerCase()) {
      alert('Por seguridad no puedes cambiar tu propio rol de administrador.');
      return;
    }

    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRoleVal }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al cambiar rol');
      }

      setSuccessMsg(`Rol de ${user.email} actualizado a ${newRoleVal === 'admin' ? 'Administrador' : 'Interno'}.`);
      fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Error al actualizar rol');
    }
  };

  const handleDeleteUser = async (userToDelete: AppUser) => {
    if (userToDelete.email.toLowerCase() === currentUser?.email.toLowerCase()) {
      alert('Por seguridad no puedes revocar tu propia cuenta de administrador.');
      return;
    }

    const confirm = window.confirm(
      `¿Estás seguro de que deseas revocar el acceso a ${userToDelete.email}?`
    );
    if (!confirm) return;

    setDeletingId(userToDelete.id);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/users/${userToDelete.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al eliminar usuario');
      }

      setSuccessMsg(`Acceso revocado para ${userToDelete.email}.`);
      fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Error al eliminar');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-pink-500 flex items-center justify-center text-white shadow-md shadow-indigo-950/50">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-base text-slate-100">Gestión de Usuarios</h3>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-indigo-950/60 text-indigo-400 border border-indigo-800/60">
                  Acceso Corporativo
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Control de miembros autorizados con dominio <span className="text-pink-400 font-semibold">@nexitty.com</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 text-sm">
          {/* Mensajes de Feedback */}
          {error && (
            <div className="p-3.5 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-300 flex items-center gap-2.5">
              <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3.5 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-xs text-emerald-300 flex items-center gap-2.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Formulario Agregar Usuario */}
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
              <UserPlus className="h-4 w-4 text-pink-400" />
              <span>Agregar Nuevo Miembro</span>
            </div>

            <form onSubmit={handleAddUser} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                <div className="sm:col-span-5">
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Correo (@nexitty.com)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Mail className="h-3.5 w-3.5" />
                    </div>
                    <input
                      type="email"
                      required
                      placeholder="nombre.apellido@nexitty.com"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500/80 transition-all placeholder:text-slate-600"
                    />
                  </div>
                </div>

                <div className="sm:col-span-4">
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Contraseña Inicial (min 6 car.)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <KeyRound className="h-3.5 w-3.5" />
                    </div>
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      required
                      placeholder="••••••••"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full pl-9 pr-8 py-2 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500/80 transition-all placeholder:text-slate-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-500 hover:text-slate-300 cursor-pointer"
                    >
                      {showNewPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">Rol</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as 'internal' | 'admin')}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700/80 rounded-lg text-xs font-semibold text-slate-200 focus:outline-none focus:ring-2 focus:ring-pink-500/80 cursor-pointer"
                  >
                    <option value="internal">Interno</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting || !newEmail || !newPassword}
                  className="py-2 px-4 rounded-lg font-semibold text-xs text-white bg-pink-600 hover:bg-pink-500 active:scale-95 transition-all flex items-center justify-center gap-1.5 shadow-md shadow-pink-950/40 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {submitting ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <span>+ Crear y Asignar Usuario</span>
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Tabla de Usuarios Registrados */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <span>Miembros del Sistema</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-800 text-slate-400 font-mono">
                  {users.length} autorizados
                </span>
              </span>
              <button
                onClick={fetchUsers}
                disabled={loading}
                className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                <span>Actualizar</span>
              </button>
            </div>

            {loading ? (
              <div className="p-8 text-center text-slate-500 flex items-center justify-center gap-2">
                <RefreshCw className="h-4 w-4 animate-spin text-pink-500" />
                <span className="text-xs">Cargando usuarios...</span>
              </div>
            ) : users.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs">
                No hay usuarios registrados en el sistema.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {users.map((u) => {
                  const isCurrent =
                    u.email.toLowerCase() === currentUser?.email.toLowerCase();
                  const isEditingPassword = editingUserId === u.id;

                  return (
                    <div
                      key={u.id}
                      className="p-4 hover:bg-slate-900/40 transition-colors space-y-2.5"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                              u.role === 'admin'
                                ? 'bg-indigo-950/80 text-indigo-400 border border-indigo-800/60'
                                : 'bg-slate-800 text-slate-400 border border-slate-700/60'
                            }`}
                          >
                            {u.role === 'admin' ? (
                              <Shield className="h-4 w-4" />
                            ) : (
                              <User className="h-4 w-4" />
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-200 text-xs">
                                {u.email}
                              </span>
                              {isCurrent && (
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-pink-950/60 text-pink-400 border border-pink-800/60">
                                  Tú (Sesión actual)
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono">
                              Registrado: {new Date(u.created_at).toLocaleDateString('es-CL')}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-end sm:self-center">
                          {/* Selector de Rol */}
                          <select
                            value={u.role}
                            disabled={isCurrent}
                            onChange={(e) =>
                              handleRoleChange(u, e.target.value as 'admin' | 'internal')
                            }
                            className={`text-xs px-2.5 py-1 rounded-md border font-medium focus:outline-none cursor-pointer ${
                              u.role === 'admin'
                                ? 'bg-indigo-950/60 border-indigo-700/60 text-indigo-300'
                                : 'bg-slate-800/80 border-slate-700/60 text-slate-300'
                            } disabled:opacity-70 disabled:cursor-not-allowed`}
                          >
                            <option value="internal">Interno</option>
                            <option value="admin">Administrador</option>
                          </select>

                          {/* Botón Resetear Contraseña */}
                          <button
                            onClick={() => {
                              if (isEditingPassword) {
                                setEditingUserId(null);
                                setResetPasswordVal('');
                              } else {
                                setEditingUserId(u.id);
                                setResetPasswordVal('');
                              }
                            }}
                            className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded-lg transition-colors title='Cambiar contraseña' cursor-pointer"
                            title="Cambiar contraseña"
                          >
                            <KeyRound className="h-4 w-4" />
                          </button>

                          {/* Botón Eliminar */}
                          <button
                            onClick={() => handleDeleteUser(u)}
                            disabled={isCurrent || deletingId === u.id}
                            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/40 rounded-lg transition-colors disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:text-slate-400 cursor-pointer disabled:cursor-not-allowed"
                            title={
                              isCurrent
                                ? 'No puedes eliminar tu propia cuenta'
                                : 'Revocar acceso'
                            }
                          >
                            {deletingId === u.id ? (
                              <RefreshCw className="h-4 w-4 animate-spin text-red-400" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Sub-formulario para cambiar contraseña */}
                      {isEditingPassword && (
                        <div className="pt-2 pl-11 pr-2">
                          <div className="bg-slate-900 border border-indigo-900/50 rounded-lg p-3 flex flex-col sm:flex-row items-center gap-2.5">
                            <div className="flex-1 w-full relative">
                              <input
                                type={showResetPassword ? 'text' : 'password'}
                                placeholder="Nueva contraseña (mínimo 6 caracteres)"
                                value={resetPasswordVal}
                                onChange={(e) => setResetPasswordVal(e.target.value)}
                                className="w-full px-3 py-1.5 pr-8 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                              />
                              <button
                                type="button"
                                onClick={() => setShowResetPassword(!showResetPassword)}
                                className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-500 hover:text-slate-300 cursor-pointer"
                              >
                                {showResetPassword ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                              <button
                                type="button"
                                disabled={savingPassword || resetPasswordVal.length < 6}
                                onClick={() => handleResetPassword(u)}
                                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                              >
                                {savingPassword ? 'Guardando...' : 'Guardar Nueva'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingUserId(null);
                                  setResetPasswordVal('');
                                }}
                                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition-colors cursor-pointer"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span>Solo cuentas activas pueden autenticarse en el panel</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
