'use client';

import { useEffect, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';
import { StudioAuth } from '../components/studio-auth';
import { LoadingScreen } from '../components/admin-ui';
import { configureAuth, authConfigured } from '../lib/auth';
import { studioApi } from '../lib/studio-client';

export default function Home() {
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      if (!authConfigured() || !configureAuth()) {
        if (active) {
          setAuthenticated(true);
          setAuthReady(true);
        }
        return;
      }

      try {
        const token = (await fetchAuthSession()).tokens?.idToken;
        if (token) {
          await studioApi('/api/admin-session');
          if (active) setAuthenticated(true);
        }
      } catch {
        // An unauthenticated visitor stays on the sign-in screen.
      } finally {
        if (active) setAuthReady(true);
      }
    }

    void checkSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (authReady && authenticated) router.replace('/dashboard');
  }, [authReady, authenticated, router]);

  if (!authReady || authenticated) return <LoadingScreen />;
  return <StudioAuth signedIn={() => setAuthenticated(true)} />;
}
