/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // `web/.env`; the '' prefix also loads keys without VITE_ (config-only, not sent to the client).
  const env = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env };
  const apiTarget = env.OTAGO_API_URL ?? 'http://127.0.0.1:3001';

  return {
    plugins: [react()],
    // Vitest stubs CSS to '' by default; theme.test.ts reads themes.css?raw.
    test: { css: { include: [/themes\.css/] } },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
