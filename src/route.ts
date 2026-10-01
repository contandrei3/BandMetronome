/**
 * The session lives in the URL hash (#master/1234 or #join/1234), so a
 * refresh lands back in the same session instead of on the start screen.
 * GitHub Pages serves a single index.html, hence the hash instead of paths.
 */
export type Role = 'master' | 'join';
export interface Route {
  role: Role;
  code: string;
}

export function parseRoute(hash: string, search: string): Route | null {
  const m = /^#?(master|join)\/(\d{4})$/.exec(hash);
  if (m) return { role: m[1] as Role, code: m[2] };
  // Older QR codes used ?join=1234.
  const legacy = new URLSearchParams(search).get('join');
  return legacy && /^\d{4}$/.test(legacy) ? { role: 'join', code: legacy } : null;
}

export function routeHash(r: Route): string {
  return `#${r.role}/${r.code}`;
}
