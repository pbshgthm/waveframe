import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 55383,
    strictPort: true,
    allowedHosts: ['.local'],
  },
  preview: {
    host: true,
    port: 55383,
    strictPort: true,
    allowedHosts: ['.local'],
  },
});
