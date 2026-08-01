import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Segunda piel (Chakra UI) del front. Dev server en :5174, distinto del Vite
// "principal" (:5173) para poder correr ambos a la vez. La API corre en :3000
// con CORS abierto a ambos origenes, por lo que no hace falta proxy.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5174 },
  preview: { port: 4174 },
});
