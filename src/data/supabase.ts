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
