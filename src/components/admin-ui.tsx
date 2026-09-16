import { LoaderCircle, Sparkles } from 'lucide-react';
export function Spinner({ label }: { label?: string }) { return <span className="spinner" role="status"><LoaderCircle size={17}/>{label}</span>; }
export function Notice({ children }: { children?: React.ReactNode }) { return children ? <div className="notice" role="status">{children}</div> : null; }
export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) { return <div className="admin-empty"><Sparkles size={25}/><h2>{title}</h2><p>{description}</p>{action}</div>; }
export function LoadingScreen() { return <main className="app-loading"><span className="brand-mark"><Sparkles size={24}/></span><Spinner/><p className="eyebrow">AMBATUAPP / ADMIN</p><h1>Opening the <em>Ambaverse.</em></h1><p>Restoring your secure admin session…</p></main>; }
