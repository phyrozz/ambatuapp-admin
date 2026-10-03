export const ROLE_TYPES = ['view', 'add', 'edit', 'delete', 'upload', 'download'];
export const STUDIO_MODULES = [
  { id: 'characters', href: '/', key: 'studio.modules.characters' },
  { id: 'lores', href: '/lores', key: 'studio.modules.lores' },
  { id: 'videos', href: '/videos', key: 'studio.modules.videos' },
  { id: 'sounds', href: '/sounds', key: 'studio.modules.sounds' },
  { id: 'profile-avatars', href: '/profile-avatars', key: 'studio.modules.profileAvatars' },
  { id: 'chat-reports', href: '/chat-reports', key: 'studio.modules.chatReports' },
  { id: 'users', href: '/users', key: 'studio.modules.users' },
  { id: 'roles', href: '/roles', key: 'studio.modules.roles' },
];
export function rootPermissions() {
  return Object.fromEntries(STUDIO_MODULES.map(module => [module.id, [...ROLE_TYPES]]));
}
export function canAccess(permissions, module, action) {
  return STUDIO_MODULES.some(item => item.id === module) && ROLE_TYPES.includes(action)
    && Array.isArray(permissions?.[module]) && permissions[module].includes(action);
}
export function normalizePermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('studio.errors.permissions');
  if (Object.keys(value).some(key => !STUDIO_MODULES.some(module => module.id === key))) throw new Error('studio.errors.permissions');
  return Object.fromEntries(STUDIO_MODULES.map(module => {
    const actions = value[module.id] ?? [];
    if (!Array.isArray(actions) || actions.some(action => !ROLE_TYPES.includes(action))) throw new Error('studio.errors.permissions');
    const normalized = ROLE_TYPES.filter(action => actions.includes(action));
    if (normalized.length && !normalized.includes('view')) throw new Error('studio.errors.viewRequired');
    return [module.id, normalized];
  }));
}
export function permissionForRequest(pathname, method) {
  if (pathname === '/api/admin-session') return null;
  const segment = pathname.split('/')[2];
  const moduleId = ({ 'admin-users': 'users', 'profile-avatar-moderation': 'profile-avatars', 'chat-restrictions': 'chat-reports' })[segment] ?? segment;
  if (!STUDIO_MODULES.some(item => item.id === moduleId)) throw new Error('studio.errors.forbidden');
  // Polling a transcode can finalize an upload, so it also requires Upload.
  const action = /\/(download|export|bulk-download|bulk-export)$/.test(pathname) ? 'download'
    : /\/(presign|transcode|upload|import|bulk-upload|bulk-import)$/.test(pathname) ? 'upload'
    : method === 'GET' ? 'view' : method === 'DELETE' ? 'delete'
      : method === 'PATCH' || method === 'PUT' ? 'edit' : method === 'POST' ? 'add' : null;
  if (!action) throw new Error('studio.errors.forbidden');
  return { module: moduleId, action };
}
export function validateProfile(body) {
  const profile = {};
  for (const [key, max, required] of [['firstName', 80, true], ['lastName', 80, true], ['displayName', 80, true], ['country', 80, true], ['bio', 1000, false]]) {
    const value = typeof body[key] === 'string' ? body[key].normalize('NFKC').trim() : '';
    if ((required && !value) || value.length > max) throw new Error('studio.errors.profile');
    profile[key] = value;
  }
  return profile;
}
export function validateCredentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('studio.errors.email');
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new Error('studio.errors.password');
  if (body.password !== body.confirmPassword) throw new Error('studio.errors.passwordMismatch');
  return { email, password: body.password };
}
