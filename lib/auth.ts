import crypto from 'crypto';

export const COOKIE_SESSION_NAME = 'vtex_catalog_session';

// Salt interno para derivación de clave
const SESSION_SALT = 'vtex_catalog_engine_session_salt_2026';

/**
 * Genera un token HMAC-SHA256 seguro derivado de la contraseña maestra.
 * De esta manera, el valor de la cookie nunca expone la contraseña en texto plano.
 */
export function createSessionToken(password: string): string {
  return crypto
    .createHmac('sha256', SESSION_SALT)
    .update(password)
    .digest('hex');
}

/**
 * Valida el token de sesión usando comparación en tiempo constante (timingSafeEqual)
 * para mitigar ataques de temporización (timing attacks).
 */
export function verifySessionToken(token: string | undefined | null, masterPassword: string | undefined | null): boolean {
  if (!token || !masterPassword) return false;

  const expectedToken = createSessionToken(masterPassword);
  
  if (token.length !== expectedToken.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expectedToken, 'utf8'));
  } catch {
    return false;
  }
}
