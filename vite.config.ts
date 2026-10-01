import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/.
  base: './',
  define: {
    __BUILD__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev'),
  },
  plugins: [tailwindcss()],
});
