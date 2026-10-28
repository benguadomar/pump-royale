import { defineConfig } from 'vite';
import typegpu from 'unplugin-typegpu/vite';

export default defineConfig({
  plugins: [typegpu()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
    // The game server rewrites server/data/players.json; without this every save reloads all clients.
    watch: { ignored: ['**/server/**', '**/.vid/**'] },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
