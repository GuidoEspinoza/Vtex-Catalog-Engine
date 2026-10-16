import crypto from 'crypto';

export const COOKIE_SESSION_NAME = 'vtex_catalog_session';

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'internal';
  name?: string;
}

interface TokenPayload extends SessionUser {
  exp: number;
}

function getAuthSecret(): string {
  return (
    process.env.AUTH_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'vtex_catalog_engine_fallback_secret_key_2026'
  );
}

/**
 * Genera un token HMAC-SHA256 firmado con los datos del usuario y su rol.
 * Formato: base64url(payload).hmac_signature
 */
export function createSessionToken(user: SessionUser): string {
  const secret = getAuthSecret();
  const payload: TokenPayload = {
    id: user.id,
    email: user.email.toLowerCase().trim(),
    role: user.role,
    name: user.name || user.email.split('@')[0],
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 días de vigencia
  };

  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');

  return `${data}.${signature}`;
}

/**
 * Verifica y decodifica un token de sesión, retornando los datos del usuario y su rol.
 */
export function verifySessionToken(token: string | undefined | null): SessionUser | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [data, signature] = parts;
  const secret = getAuthSecret();

  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('base64url');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    const payload: TokenPayload = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf8')
    );

    // Verificar si el token expiró
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      id: payload.id,
      email: payload.email,
      role: payload.role === 'admin' ? 'admin' : 'internal',
      name: payload.name,
    };
  } catch {
    return null;
  }
}
