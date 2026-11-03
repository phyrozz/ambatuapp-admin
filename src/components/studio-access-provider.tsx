'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { canAccess, type ModuleId, type Permissions, type RoleType, type StudioUser } from '../lib/studio-policy.mjs';
import { studioApi } from '../lib/studio-client';
import { authConfigured } from '../lib/auth';
import { rootPermissions } from '../lib/studio-policy.mjs';
type Access = { ready: boolean; denied: boolean; permissions: Permissions; roleId: string | null; roleName: string | null; profile: StudioUser | null };
type AccessContext = Access & { refresh: () => Promise<void> };
const initial: Access = { ready: false, denied: false, permissions: {}, roleId: null, roleName: null, profile: null };
const Context = createContext<AccessContext>({ ...initial, refresh: async () => {} });
export function StudioAccessProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [access, setAccess] = useState<Access>(initial);
  const latestRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const data = authConfigured() ? await studioApi('/api/admin-session') : { permissions: rootPermissions(), roleId: 'root', roleName: null, profile: null };
      if (request === latestRequest.current) setAccess({ ...data, ready: true, denied: false });
    } catch {
      if (request === latestRequest.current) setAccess({ ...initial, ready: true, denied: true });
    }
  }, []);
  useEffect(() => {
    let active = true;
    const verify = () => { if (active) void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') verify(); };
    verify();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const interval = pathname === '/' ? null : window.setInterval(verify, 30_000);
    return () => { active = false; if (interval) window.clearInterval(interval); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [pathname, refresh]);
  return <Context.Provider value={{ ...access, refresh }}>{children}</Context.Provider>;
}
export function useStudioAccess() {
  const access = useContext(Context);
  return { ...access, can: (module: ModuleId, action: RoleType) => canAccess(access.permissions, module, action) };
}
export function Allowed({ module, action, children }: { module: ModuleId; action: RoleType; children: React.ReactNode }) {
  const { can } = useStudioAccess();
  return can(module, action) ? children : null;
}
