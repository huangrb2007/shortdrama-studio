import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react'; import path from 'node:path';
const p = (n: string) => path.resolve(__dirname, `../../packages/${n}/src/index.ts`);
export default defineConfig({ plugins: [react()], base: './', resolve: { alias: { '@studio/domain': p('domain') } }, build: { outDir: 'dist', emptyOutDir: true }, server: { proxy: { '/api': { target: 'http://127.0.0.1:4173', ws: true }, '/media': 'http://127.0.0.1:4173' } } });
