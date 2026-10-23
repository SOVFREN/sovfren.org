// Admin gate shared by the portal pages: Companion Numbers listed in
// ADMIN_COMPANION_NUMBERS (comma-separated; defaults to the Principal's).
export function isAdminCompanion(companionNumber?: string | null): boolean {
  if (!companionNumber) return false;
  const admins = (import.meta.env.ADMIN_COMPANION_NUMBERS ?? 'SovfCom00000001')
    .split(',')
    .map((n: string) => n.trim());
  return admins.includes(companionNumber);
}
