/** Explicit entries match Host including its port; an omitted list preserves defaults. */
export function isAllowedMcpHost(
  host: string | undefined,
  resource: URL,
  configured: string | undefined,
  production: boolean,
): boolean {
  if (!host) return false;
  const defaults = [resource.host];
  if (!production)
    defaults.push('127.0.0.1:' + resource.port, 'localhost:' + resource.port);
  const allowed = configured?.trim()
    ? configured.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
    : defaults.map((value) => value.toLowerCase());
  return allowed.includes('*') || allowed.includes(host.toLowerCase());
}
