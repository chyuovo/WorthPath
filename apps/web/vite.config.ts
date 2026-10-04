import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, resolve(__dirname, '../api'), ''), ...process.env };
  const allowed = env.WEB_ALLOWED_HOSTS || '*';
  return {
    plugins: [react()],
    server: {
      host: env.WEB_HOST || '0.0.0.0',
      port: Number(env.WEB_PORT || 5173),
      allowedHosts:
        allowed.trim() === '*'
          ? true
          : allowed
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
      proxy: { '/api': env.WEB_API_PROXY || 'http://127.0.0.1:3100' },
    },
  };
});
