'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { AudioLines, BookOpen, ChevronDown, Flag, Image, LogOut, ShieldCheck, UsersRound, Video } from 'lucide-react';
import { signOut } from 'aws-amplify/auth';
import { authConfigured } from '../lib/auth';
import { STUDIO_MODULES } from '../lib/studio-policy.mjs';
import { StudioAccessProvider, useStudioAccess } from './studio-access-provider';
import { useI18n } from './studio-i18n';
import { LoadingScreen } from './admin-ui';
import { StudioBrand } from './studio-brand';
const icons = [UsersRound, BookOpen, Video, AudioLines, Image, Flag, UsersRound, ShieldCheck];
export function AdminShell({ children, onSignedOut }: { children: React.ReactNode; onSignedOut?: () => void }) {
  return <StudioAccessProvider><Shell onSignedOut={onSignedOut}>{children}</Shell></StudioAccessProvider>;
}
function Shell({ children, onSignedOut }: { children: React.ReactNode; onSignedOut?: () => void }) {
  const { t } = useI18n();
  const { ready, denied, can, roleId, roleName, profile } = useStudioAccess();
  const path = usePathname(), router = useRouter(), mobileMenu = useRef<HTMLDetailsElement>(null);
  const links = STUDIO_MODULES.map((module, index) => ({ ...module, Icon: icons[index] })).filter(module => can(module.id, 'view'));
  const current = STUDIO_MODULES.find(module => module.href === path);
  const close = () => { if (mobileMenu.current) mobileMenu.current.open = false; };
  useEffect(() => {
    close();
    function dismiss(event: PointerEvent) { if (event.target instanceof Node && !mobileMenu.current?.contains(event.target)) close(); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { close(); mobileMenu.current?.querySelector('summary')?.focus(); } }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [path]);
  async function logout() { if (authConfigured()) await signOut(); onSignedOut?.(); if (!onSignedOut) router.replace('/'); }
  if (!ready) return <LoadingScreen/>;
  if (denied) return <main className="admin-access-denied"><section><ShieldCheck/><h1>{t('studio.access.deniedTitle')}</h1><p>{t('studio.access.denied')}</p><button className="button primary" onClick={() => void logout()}>{t('studio.common.signOut')}</button></section></main>;
  const navigation = (access: boolean) => links.filter(module => ['users', 'roles'].includes(module.id) === access).map(({ href, key, Icon }) => <Link key={href} href={href} className={path === href ? 'active' : ''} aria-current={path === href ? 'page' : undefined} onClick={close}><Icon size={18}/>{t(key)}</Link>);
  return <main className="admin-shell"><aside className="admin-sidebar"><Link className="admin-logo" href={links[0]?.href ?? '/'}><StudioBrand/></Link><p className="nav-heading">{t('studio.common.content')}</p><nav>{navigation(false)}</nav><p className="nav-heading admin-access-heading">{t('studio.common.access')}</p><nav>{navigation(true)}</nav><div className="admin-account"><span className="avatar">{profile?.displayName?.[0] ?? 'A'}</span><div><strong>{profile?.displayName || t('studio.common.team')}</strong><small>{roleId === 'root' ? t('studio.roles.root') : roleName || t('studio.fields.noRole')}</small></div><button aria-label={t('studio.common.signOut')} onClick={() => void logout()}><LogOut size={17}/></button></div></aside><header className="admin-mobile"><div className="admin-mobile-topbar"><Link className="admin-logo" href={links[0]?.href ?? '/'}><StudioBrand/></Link><button className="admin-mobile-signout" aria-label={t('studio.common.signOut')} onClick={() => void logout()}><LogOut size={18}/></button></div><details className="admin-mobile-menu" ref={mobileMenu}><summary><ShieldCheck size={18}/><span>{t(current?.key ?? 'studio.common.studio')}</span><ChevronDown size={18}/></summary><div className="admin-mobile-panel"><p className="nav-heading">{t('studio.common.content')}</p><nav>{navigation(false)}</nav><p className="nav-heading">{t('studio.common.access')}</p><nav>{navigation(true)}</nav></div></details></header><section className="admin-main">{!links.length ? <section className="studio-welcome"><ShieldCheck size={32}/><h1>{t('studio.access.pendingTitle')}</h1><p>{t('studio.access.pending')}</p><button className="button ghost" onClick={() => window.location.reload()}>{t('studio.common.refresh')}</button></section> : current && !can(current.id, 'view') ? <section className="studio-welcome"><h1>{t(current.key)}</h1><p>{t('studio.access.moduleDenied')}</p>{links.map(module => <Link className="button ghost" href={module.href} key={module.id}>{t(module.key)}</Link>)}</section> : children}</section></main>;
}
export function PageHeader({ eyebrow, title, count, description, action }: { eyebrow: string; title: string; count?: number; description?: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}{typeof count === 'number' && <span>{count}</span>}</h1>{description && <p className="page-description">{description}</p>}</div>{action}</header>;
}
