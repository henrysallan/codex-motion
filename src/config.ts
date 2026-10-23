// Deployment config from Vite env vars (see .env.example). With no
// Supabase URL the app runs fully local: IndexedDB for data, OPFS and the
// dev server's public/media for media.

const env = import.meta.env;

export const config = {
  supabaseUrl: env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY as string | undefined,
  // Origin of the media Worker in front of R2, e.g. https://motion-media.isthishenry.com
  mediaUrl: (env.VITE_MEDIA_URL as string | undefined)?.replace(/\/$/, ''),
  // Embeds search text with the library's image model (api/embed.ts; the
  // dev server serves it too). Empty turns visual text search off.
  embedUrl: (env.VITE_EMBED_URL as string | undefined) ?? '/api/embed',
};

export const remoteEnabled = !!(config.supabaseUrl && config.supabaseAnonKey);
