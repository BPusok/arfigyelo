import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Relatív útvonalak, így GitHub Pages-en és Vercelen is azonnal működik
  build: {
    outDir: 'dist',
  },
});
