'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { canAccess, type ModuleId, type Permissions, type RoleType, type StudioUser } from '../lib/studio-policy.mjs';
import { studioApi } from '../lib/studio-client';
import { authConfigured } from '../lib/auth';
import { rootPermissions } from '../lib/studio-policy.mjs';
type Access = { ready: boolean; denied: boolean; permissions: Permissions; roleId: string | null; roleName: string | null; profile: StudioUser | null };
const initial: Access = { ready: false, denied: false, permissions: {}, roleId: null, roleName: null, profile: null };
const Context = createContext<Access>(initial);
export function StudioAccessProvider({ children }: { children: React.ReactNode }) {
  const [access, setAccess] = useState<Access>(initial);
  useEffect(() => {
    let active = true;
    async function verify() {
      try {
        const data = authConfigured() ? await studioApi('/api/admin-session') : { permissions: rootPermissions(), roleId: 'root', roleName: null, profile: null };
        if (active) setAccess({ ...data, ready: true, denied: false });
      } catch { if (active) setAccess({ ...initial, ready: true, denied: true }); }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void verify(); };
    void verify();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => void verify(), 30_000);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return <Context.Provider value={access}>{children}</Context.Provider>;
}
export function useStudioAccess() {
  const access = useContext(Context);
  return { ...access, can: (module: ModuleId, action: RoleType) => canAccess(access.permissions, module, action) };
}
export function Allowed({ module, action, children }: { module: ModuleId; action: RoleType; children: React.ReactNode }) {
  const { can } = useStudioAccess();
  return can(module, action) ? children : null;
}
