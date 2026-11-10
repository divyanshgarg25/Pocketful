import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Demo UI (prefilled demo identity + 1-click demo) exists only in dev/test, or in a build that sets
  // VITE_ENABLE_DEMO=true on purpose. A compile-time constant lets the bundler remove it from production builds.
  define: {
    __DEMO_UI__: JSON.stringify(mode !== 'production' || process.env['VITE_ENABLE_DEMO'] === 'true')
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/healthz': 'http://localhost:3001'
    }
  }
}));
