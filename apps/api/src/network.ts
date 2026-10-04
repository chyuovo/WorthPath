export function networkFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw Error(name + ' must be true or false');
}
export function networkNumber(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw Error(name + ' must be a positive integer');
  return value;
}
export function networkConfig() {
  const production = process.env.NODE_ENV === 'production';
  const sameSite = process.env.COOKIE_SAME_SITE || 'strict';
  if (!['strict', 'lax', 'none'].includes(sameSite)) throw Error('Invalid COOKIE_SAME_SITE');
  const cookieSecure = networkFlag('COOKIE_SECURE', production);
  if (sameSite === 'none' && !cookieSecure)
    throw Error('SameSite=None requires COOKIE_SECURE=true');
  return {
    rateLimitEnabled: networkFlag('NETWORK_RATE_LIMIT_ENABLED', true),
    rateLimitWindowMs: networkNumber('NETWORK_RATE_LIMIT_WINDOW_MS', 900000),
    authRateLimitMax: networkNumber('NETWORK_AUTH_RATE_LIMIT_MAX', 30),
    mcpAuthRateLimitMax: networkNumber('MCP_AUTH_RATE_LIMIT_MAX', 100),
    allowHttp: networkFlag('NETWORK_ALLOW_HTTP', !production),
    allowWildcardOrigins: networkFlag('NETWORK_ALLOW_WILDCARD_ORIGINS', !production),
    allowHttpRedirects: networkFlag('NETWORK_ALLOW_HTTP_REDIRECTS', !production),
    requireSecureCookie: networkFlag('NETWORK_REQUIRE_SECURE_COOKIE', production),
    hsts: networkFlag('NETWORK_HSTS', production),
    upgradeInsecureRequests: networkFlag('NETWORK_UPGRADE_INSECURE_REQUESTS', production),
    allowLoopbackHosts: networkFlag('MCP_ALLOW_LOOPBACK_HOSTS', !production),
    apiHost: process.env.API_HOST || '0.0.0.0',
    apiAllowedHosts: process.env.API_ALLOWED_HOSTS || '*',
    cookieSecure,
    sameSite: sameSite as 'strict' | 'lax' | 'none',
  };
}
export function isNetworkOriginAllowed(
  origin: string | undefined,
  configured: string | undefined,
  wildcard: boolean,
): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
    const list = (configured || '').split(',').map((s) => s.trim());
    return list.includes(origin) || (wildcard && list.includes('*'));
  } catch {
    return false;
  }
}
export function isNetworkHostAllowed(host: string | undefined, configured: string): boolean {
  if (!host) return false;
  const list = configured.split(',').map((s) => s.trim().toLowerCase());
  return list.includes('*') || list.includes(host.toLowerCase());
}
