/**
 * Entrypoint serverless para Vercel (@vercel/node).
 *
 * Reutiliza la app Express de src/app.ts SIN llamar a listen: Vercel envuelve
 * este `app` como función serverless. El arranque local sigue usando
 * src/index.ts (npm run dev), que sí hace app.listen.
 *
 * vercel.json reescribe todas las rutas a /api, así que esta función atiende
 * /auth/login, /companies/:id/..., /health, etc.
 *
 * Limitaciones conocidas en serverless (ver docs/ADR / respuesta de despliegue):
 *  - El estado en memoria no persiste entre invocaciones.
 *  - La escritura en disco (storage/...) requiere Vercel Blob/S3.
 */
import { app } from '../src/app';

export default app;
