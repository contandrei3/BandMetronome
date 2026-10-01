import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/.
  base: './',
  define: {
    __BUILD__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev'),
  },
  // Firestore is loaded on demand in its own chunk; it is large but off the startup path.
  build: { chunkSizeWarningLimit: 700 },
  plugins: [tailwindcss()],
});
