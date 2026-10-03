import type { Metadata } from 'next';
import './globals.css';
import { StudioI18nProvider } from '../components/studio-i18n';
export const metadata: Metadata = { title: 'AmbatuApp Studio', description: 'AmbatuApp content creation and management studio', icons: { icon: [{ url: '/favicon.ico', sizes: '32x32', type: 'image/x-icon' }, { url: '/app-icon.svg', type: 'image/svg+xml' }], apple: '/apple-touch-icon.png' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><StudioI18nProvider>{children}</StudioI18nProvider></body></html>; }
