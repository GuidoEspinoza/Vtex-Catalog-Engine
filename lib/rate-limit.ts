interface RateLimitRecord {
  attempts: number;
  blockedUntil: number;
}

const loginAttempts = new Map<string, RateLimitRecord>();

const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutos

/**
 * Controla intentos fallidos de login por dirección IP para prevenir ataques de fuerza bruta.
 */
export function checkLoginRateLimit(ip: string): { allowed: boolean; remainingAttempts: number; retryAfterSeconds?: number } {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (record && record.blockedUntil > now) {
    const retryAfterSeconds = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, remainingAttempts: 0, retryAfterSeconds };
  }

  // Si ya pasó el tiempo de bloqueo, limpiar el registro
  if (record && record.blockedUntil <= now && record.blockedUntil > 0) {
    loginAttempts.delete(ip);
  }

  const currentAttempts = loginAttempts.get(ip)?.attempts || 0;
  return { allowed: true, remainingAttempts: Math.max(0, MAX_ATTEMPTS - currentAttempts) };
}

export function recordFailedLogin(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { attempts: 0, blockedUntil: 0 };
  record.attempts += 1;

  if (record.attempts >= MAX_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
  }

  loginAttempts.set(ip, record);
}

export function resetLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}
