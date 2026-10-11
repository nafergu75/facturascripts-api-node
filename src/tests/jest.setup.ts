// Variables de entorno minimas para que config/env.ts valide durante los tests.
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3000';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/fs_api_node';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.FS_API_URL = process.env.FS_API_URL ?? 'http://localhost:8000/api/3';
process.env.FS_API_KEY = process.env.FS_API_KEY ?? 'test-api-key';
// Reloj de la red de seguridad de VERI*FACTU (services/verifactu/redSeguridad.ts):
// fijo antes del 1-1-2027 para que los tests que emiten facturas sigan pasando en
// 2027. Los tests de la red lo cambian para situarse a un lado y otro de la fecha.
process.env.VERIFACTU_RED_RELOJ_PRUEBAS = process.env.VERIFACTU_RED_RELOJ_PRUEBAS ?? '2026-11-15T12:00:00Z';
