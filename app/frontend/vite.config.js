import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = Number.parseInt(process.env.VITE_PORT || '5175', 10);
const host = process.env.VITE_HOST || 'localhost';
const apiUrl = process.env.VITE_API_URL || 'http://localhost:8090';

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port,
    proxy: {
      '/api': {
        target: apiUrl,
        changeOrigin: true,
      },
    },
  },
});
