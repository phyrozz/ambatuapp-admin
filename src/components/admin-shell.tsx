'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BookOpen, Flag, Image, LogOut, Sparkles, UsersRound, Video } from 'lucide-react';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { authConfigured, configureAuth } from '../lib/auth';
import { LoadingScreen } from './admin-ui';

const links = [
  { href: '/', label: 'Characters', Icon: UsersRound },
  { href: '/lores', label: 'Lore archive', Icon: BookOpen },
  { href: '/videos', label: 'Videos', Icon: Video },
  { href: '/profile-avatars', label: 'Profile images', Icon: Image },
  { href: '/chat-reports', label: 'Chat reports', Icon: Flag },
];

export function AdminShell({ children, onSignedOut }: { children: React.ReactNode; onSignedOut?: () => void }) {
  const path = usePathname();
  const router = useRouter();
  const [sessionReady, setSessionReady] = useState(Boolean(onSignedOut) || !authConfigured());
  useEffect(() => {
    if (!authConfigured() || !configureAuth()) { if (authConfigured()) void Promise.resolve().then(() => setSessionReady(true)); return; }
    let active = true;
    async function verify() { try { const session = await fetchAuthSession(); if (!session.tokens?.idToken) throw new Error('Session expired'); if (active) setSessionReady(true); } catch { if (active) router.replace('/'); } }
    const onVisible = () => { if (document.visibilityState === 'visible') void verify(); };
    void verify();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('storage', verify);
    const interval = window.setInterval(() => void verify(), 30_000);
    return () => { active = false; document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); window.removeEventListener('storage', verify); window.clearInterval(interval); };
  }, [router]);
  async function logout() { if (authConfigured()) await signOut(); onSignedOut?.(); if (!onSignedOut) router.replace('/'); }
  if (!sessionReady) return <LoadingScreen/>;
  return <main className="admin-shell"><aside className="admin-sidebar"><Link className="admin-logo" href="/"><span><Sparkles size={18}/></span>ambatu<b>admin</b></Link><p className="nav-heading">CONTENT</p><nav>{links.map(({ href, label, Icon }) => <Link key={href} href={href} className={path === href ? 'active' : ''}><Icon size={18}/>{label}</Link>)}</nav><div className="admin-account"><span className="avatar">A</span><div><strong>Administrator</strong><small>Content team</small></div><button aria-label="Sign out" onClick={() => void logout()}><LogOut size={17}/></button></div></aside><section className="admin-mobile"><Link className="admin-logo" href="/"><span><Sparkles size={16}/></span>ambatu<b>admin</b></Link><nav>{links.map(({ href, label, Icon }) => <Link key={href} href={href} aria-label={label} className={path === href ? 'active' : ''}><Icon size={18}/><span>{label}</span></Link>)}</nav><button className="icon-button" onClick={() => void logout()} aria-label="Sign out"><LogOut size={17}/></button></section><section className="admin-main">{children}</section></main>;
}

export function PageHeader({ eyebrow, title, count, description, action }: { eyebrow: string; title: string; count?: number; description?: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}{typeof count === 'number' && <span>{count}</span>}</h1>{description && <p className="page-description">{description}</p>}</div>{action}</header>;
}
