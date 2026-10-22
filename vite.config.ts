import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    // public/media is generated media (hundreds of MB) served alongside the
    // app in development; builds don't copy it.
    copyPublicDir: false,
  },
});
