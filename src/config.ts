// Deployment config from Vite env vars (see .env.example). With no
// Supabase URL the app runs fully local: IndexedDB for data, OPFS and the
// dev server's public/media for media.

const env = import.meta.env;

export const config = {
  supabaseUrl: env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY as string | undefined,
  // Origin of the media Worker in front of R2, e.g. https://motion-media.isthishenry.com
  mediaUrl: (env.VITE_MEDIA_URL as string | undefined)?.replace(/\/$/, ''),
};

export const remoteEnabled = !!(config.supabaseUrl && config.supabaseAnonKey);
