'use client';
import { createContext, useContext } from 'react';
import en from '../lib/studio-messages.json';
const Context = createContext({ t: (key: string, variables: Record<string, string | number> = {}) => {
  const message = (en as Record<string, string>)[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`));
} });
export function StudioI18nProvider({ children }: { children: React.ReactNode }) {
  const value = { t(key: string, variables: Record<string, string | number> = {}) {
    const message = (en as Record<string, string>)[key] ?? key;
    return message.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`));
  } };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useI18n = () => useContext(Context);
