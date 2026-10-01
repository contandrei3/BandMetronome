export type Role = 'drums' | 'lead' | 'rhythm' | 'bass' | 'vocals';

export interface RoleInfo {
  id: Role;
  label: string;
  short: string;
  icon: string;
}

export const ROLES: RoleInfo[] = [
  { id: 'drums', label: 'Tobe', short: 'Tobe', icon: '🥁' },
  { id: 'lead', label: 'Chitară lead', short: 'Lead', icon: '🎸' },
  { id: 'rhythm', label: 'Chitară ritm', short: 'Ritm', icon: '🎸' },
  { id: 'bass', label: 'Bas', short: 'Bas', icon: '🎵' },
  { id: 'vocals', label: 'Solist vocal', short: 'Voce', icon: '🎤' },
];

export function roleInfo(id: Role | null | undefined): RoleInfo | undefined {
  return ROLES.find((r) => r.id === id);
}

export function isRole(x: unknown): x is Role {
  return ROLES.some((r) => r.id === x);
}

/** True when a cue meant for `roles` (empty or missing = everyone) applies to `role`. */
export function cueIsFor(roles: Role[] | undefined, role: Role | null): boolean {
  return !roles || roles.length === 0 || (role !== null && roles.includes(role));
}
