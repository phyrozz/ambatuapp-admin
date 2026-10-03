'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { confirmSignIn, confirmSignUp, fetchAuthSession, resendSignUpCode, signIn, signOut, signUp } from 'aws-amplify/auth';
import { authConfigured, configureAuth } from '../lib/auth';
import { authErrorKey, studioApi } from '../lib/studio-client';
import { emptyDetails, PersonalDetailsFields } from './personal-details';
import { useI18n } from './studio-i18n';
import { Notice, Spinner } from './admin-ui';
import { StudioBrand } from './studio-brand';
type Mode = 'login' | 'register' | 'verify' | 'new-password' | 'complete';
const pendingKey = 'ambatu-studio-registration';
export function StudioAuth({ signedIn }: { signedIn: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('login'), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState(''), [code, setCode] = useState(''), [details, setDetails] = useState(emptyDetails), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
        if (saved && active) { setEmail(saved.email ?? ''); setDetails({ ...emptyDetails, ...saved.details }); }
        if (!configureAuth()) return;
        const token = (await fetchAuthSession()).tokens?.idToken;
        if (token?.payload.email_verified === true && active) {
          try { await studioApi('/api/admin-session'); signedIn(); }
          catch { setEmail(String(token.payload.email ?? '')); setMode('complete'); }
        }
      } catch { /* A missing or expired session starts at sign-in. */ }
    }
    void restore();
    return () => { active = false; };
    // Callback is intentionally read only for this mounted authentication flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function persist() { sessionStorage.setItem(pendingKey, JSON.stringify({ email: email.trim().toLowerCase(), details })); }
  async function finish() {
    try { await studioApi('/api/admin-session'); }
    catch {
      const token = (await fetchAuthSession()).tokens?.idToken;
      if (token?.payload.email_verified !== true) throw new Error('studio.errors.verifyEmail');
      setMode('complete'); setPassword(''); setConfirmPassword(''); return;
    }
    sessionStorage.removeItem(pendingKey); setPassword(''); setConfirmPassword(''); signedIn();
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    if (['register', 'new-password'].includes(mode) && password !== confirmPassword) { setError('studio.errors.passwordMismatch'); return; }
    setBusy(true);
    try {
      if (!authConfigured() || !configureAuth()) throw new Error('studio.errors.authConfiguration');
      if (mode === 'complete') {
        await studioApi('/api/studio-registration', { method: 'POST', body: JSON.stringify(details) });
        await fetchAuthSession({ forceRefresh: true });
        await finish(); return;
      }
      if (mode === 'register') {
        persist();
        const result = await signUp({ username: email.trim().toLowerCase(), password, options: { userAttributes: { email: email.trim().toLowerCase() } } });
        setPassword(''); setConfirmPassword('');
        setMode(result.nextStep.signUpStep === 'CONFIRM_SIGN_UP' ? 'verify' : 'login');
        if (result.nextStep.signUpStep !== 'CONFIRM_SIGN_UP') setNotice('studio.auth.verified');
        return;
      }
      if (mode === 'verify') {
        await confirmSignUp({ username: email.trim().toLowerCase(), confirmationCode: code.trim() });
        setCode(''); setMode('login'); setNotice('studio.auth.verified'); return;
      }
      if (mode === 'new-password') {
        const result = await confirmSignIn({ challengeResponse: password });
        if (!result.isSignedIn) throw new Error('studio.errors.authentication');
        await finish(); return;
      }
      // Clear any incomplete registration session before starting a new sign-in.
      if ((await fetchAuthSession()).tokens?.idToken) await signOut();
      const result = await signIn({ username: email.trim().toLowerCase(), password });
      if (!result.isSignedIn && result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setPassword(''); setConfirmPassword(''); setMode('new-password'); setNotice('studio.auth.invited'); return;
      }
      if (!result.isSignedIn && result.nextStep.signInStep === 'CONFIRM_SIGN_UP') { setPassword(''); setMode('verify'); return; }
      if (!result.isSignedIn) throw new Error('studio.errors.authentication');
      await finish();
    } catch (reason) { setError(authErrorKey(reason)); }
    finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError('');
    try { await resendSignUpCode({ username: email.trim().toLowerCase() }); setNotice('studio.auth.codeSent'); }
    catch (reason) { setError(authErrorKey(reason)); }
    finally { setBusy(false); }
  }
  function switchMode(next: Mode) { setMode(next); setPassword(''); setConfirmPassword(''); setError(''); setNotice(''); }
  const title = ({ login: 'studio.auth.signInTitle', register: 'studio.auth.registerTitle', verify: 'studio.auth.verifyTitle', 'new-password': 'studio.auth.newPasswordTitle', complete: 'studio.auth.completeTitle' })[mode];
  const note = ({ login: 'studio.auth.signInNote', register: 'studio.auth.registerNote', verify: 'studio.auth.verifyNote', 'new-password': 'studio.auth.newPasswordNote', complete: 'studio.auth.completeNote' })[mode];
  const action = ({ login: 'studio.auth.signIn', register: 'studio.auth.register', verify: 'studio.auth.verify', 'new-password': 'studio.auth.setPassword', complete: 'studio.auth.complete' })[mode];
  return <main className="auth-page"><section className="auth-brand"><div className="studio-brand"><StudioBrand/></div><h1>{t('studio.auth.hero')}</h1></section><section className="auth-panel"><form className="studio-auth-form" onSubmit={event => void submit(event)}><p className="eyebrow">{t('studio.common.studio')}</p><h2>{t(title)}</h2><p className="muted">{t(note, { email })}</p>{(mode === 'register' || mode === 'complete') && <PersonalDetailsFields value={details} onChange={setDetails} disabled={busy}/>}<label>{t('studio.fields.email')}<input type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} autoComplete="username" disabled={busy || mode === 'new-password' || mode === 'complete'} required/></label>{mode === 'verify' ? <label>{t('studio.auth.code')}<input value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" maxLength={12} required disabled={busy}/></label> : mode !== 'complete' && <><label>{t('studio.fields.password')}<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={8} maxLength={256} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required disabled={busy}/></label>{mode !== 'login' && <label>{t('studio.fields.confirmPassword')}<input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={8} maxLength={256} autoComplete="new-password" required disabled={busy}/></label>}</>}<Notice>{error ? t(error) : notice ? t(notice) : null}</Notice><button className="button primary full" disabled={busy}>{busy ? <Spinner label={t('studio.common.loading')}/> : t(action)}</button>{mode === 'login' && <button type="button" className="button link full" onClick={() => switchMode('register')} disabled={busy}>{t('studio.auth.register')}</button>}{mode === 'verify' && <button type="button" className="button link full" onClick={() => void resend()} disabled={busy}>{t('studio.auth.resend')}</button>}{mode !== 'login' && <button type="button" className="button link full" onClick={() => { if (mode === 'complete') void signOut(); switchMode('login'); }} disabled={busy}>{t('studio.auth.back')}</button>}</form></section></main>;
}
