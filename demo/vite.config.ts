import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const realClient = path.resolve(import.meta.dirname, '../web/src/api/client.ts');
const mockDir = path.resolve(import.meta.dirname, 'src/mock');
const mockClient = path.join(mockDir, 'client.ts');

/**
 * Every import of `web/src/api/client.ts` resolves to the in-browser mock instead, except the
 * imports made by the mock itself (it re-exports `ApiError` & co. from the real module).
 */
function mockApiClient(): Plugin {
  return {
    name: 'otago-demo-mock-api-client',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !/(^|\/)client(\.ts)?$/.test(source)) return null;
      if (importer.startsWith(mockDir + path.sep)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === realClient ? mockClient : null;
    },
  };
}

export default defineConfig({
  plugins: [mockApiClient(), react()],
  resolve: {
    // web/src and demo/src import these from different node_modules folders.
    dedupe: ['react', 'react-dom', '@tanstack/react-query', 'i18next', 'react-i18next'],
  },
  server: { host: '127.0.0.1', port: 5174 },
  preview: { host: '127.0.0.1', port: 4174 },
});
