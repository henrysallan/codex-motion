// The Supabase client and auth state. Null when the app runs local-only.

import { createClient, type Session } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { config, remoteEnabled } from '../config.ts';

export const supabase = remoteEnabled
  ? createClient(config.supabaseUrl!, config.supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null;

interface AuthState {
  session: Session | null;
  // False until the stored session (or an OAuth redirect) has been read.
  ready: boolean;
}

let state: AuthState = { session: null, ready: !supabase };
const listeners = new Set<() => void>();

function set(next: AuthState): void {
  state = next;
  for (const l of listeners) l();
}

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => set({ session, ready: true }));
  void supabase.auth.getSession().then(({ data }) => set({ session: data.session, ready: true }));
}

export function getSession(): Session | null {
  return state.session;
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function onAuthChange(cb: (session: Session | null) => void): () => void {
  const l = () => cb(state.session);
  listeners.add(l);
  return () => listeners.delete(l);
}

// Which sign-in methods the project has turned on (Supabase's public auth
// settings), so the sign-in screen only offers ones that work.
export async function enabledProviders(): Promise<{ google: boolean; email: boolean }> {
  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/settings`, { headers: { apikey: config.supabaseAnonKey! } });
    const s = (await res.json()) as { external?: Record<string, boolean> };
    return { google: !!s.external?.google, email: !!s.external?.email };
  } catch {
    return { google: false, email: true };
  }
}

// Emails a one-time sign-in link that returns to this page.
export async function signInWithEmail(email: string): Promise<void> {
  const { error } = await supabase!.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
  });
  if (error) throw error;
}

export async function signInWithGoogle(): Promise<void> {
  await supabase?.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

// A fresh access token for calls outside supabase-js (media uploads).
export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
