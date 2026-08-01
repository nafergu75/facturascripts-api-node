import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server del front (puerto 5173). La API corre en :3000 con CORS abierto,
// por lo que no hace falta proxy. TODO produccion: `vite build` + servir dist/
// desde Express o un estatico.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
