export type StudioContentActor = { sub: string; roleId: string | null } | undefined;

export function isStudioRoot(actor: StudioContentActor) {
  return !actor || actor.roleId === 'root';
}

export function canManageStudioContent(actor: StudioContentActor, record: Record<string, unknown>) {
  return isStudioRoot(actor) || record.createdBy === actor?.sub;
}

export function studioContentOwner(actor: StudioContentActor) {
  return actor?.sub ?? 'admin';
}
