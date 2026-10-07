import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Por defecto 'production': si el despliegue olvida definir NODE_ENV, la API
  // debe quedar en modo estricto, nunca en el relajado de desarrollo.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  // Atajo de desarrollo: aceptar tokens sin firma valida y cualquier companyId.
  // Solo tiene efecto con NODE_ENV=development y ademas este flag a '1'.
  ALLOW_INSECURE_DEV_AUTH: z.string().optional(),

  // BD propia (MySQL via Prisma)
  DATABASE_URL: z.string().min(1),

  // Clave de cifrado AES-256-GCM: 32 bytes en hex (64 caracteres)
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 64 caracteres hex (32 bytes)'),

  // Secreto JWT de la capa Node
  JWT_SECRET: z.string().min(1),

  // FacturaScripts por defecto (solo lo usa el seed; en runtime cada empresa trae los suyos)
  FS_API_URL: z.string().url().optional(),
  FS_API_KEY: z.string().optional(),

  // Claude API (Anthropic). La usan el lector de facturas y, si se enciende, la
  // capa de IA de Carmen. Opcional: sin ella Carmen responde con los datos de la
  // app y sus fichas, sin IA.
  ANTHROPIC_API_KEY: z.string().optional(),

  // --- Carmen (asistente) ---
  // Interruptor general de la capa de IA. Apagada por defecto: aunque una empresa
  // la active, no se llama a la API hasta que esto valga 'true'.
  CARMEN_LLM_ACTIVO: z.enum(['true', 'false']).default('false'),
  // Solo Haiku 4.5: los topes y la reserva por pregunta están pensados para su
  // precio. Otro modelo (o una errata) hace fallar el arranque en lugar de
  // cambiar el gasto sin avisar.
  CARMEN_MODELO: z.enum(['claude-haiku-4-5-20251001', 'claude-haiku-4-5']).default('claude-haiku-4-5-20251001'),
  // Tope de gasto de la IA en el mes, para todas las empresas juntas (euros, 1 $ = 1 €).
  CARMEN_TOPE_MENSUAL_EUR: z.coerce.number().positive().default(5),
  // Preguntas a la IA por dia: por empresa y por usuario.
  CARMEN_TOPE_EMPRESA_DIA: z.coerce.number().int().positive().default(100),
  CARMEN_TOPE_USUARIO_DIA: z.coerce.number().int().positive().default(15),
  // Mensajes a Carmen por usuario y dia, de cualquier tipo (freno contra abusos).
  CARMEN_MENSAJES_USUARIO_DIA: z.coerce.number().int().positive().default(300),
  // Tokens de salida de cada respuesta de la IA (500 como maximo).
  CARMEN_MAX_TOKENS_SALIDA: z.coerce.number().int().positive().max(500).default(500),

  // Secreto con el que Vercel Cron llama a las tareas programadas (cabecera
  // Authorization: Bearer ...). Sin él, las rutas /cron/* no hacen nada.
  CRON_SECRET: z.string().min(16).optional(),

  // Origenes permitidos por CORS (lista separada por comas). En produccion es
  // OBLIGATORIO acotar a los dominios del frontend. Por defecto, los puertos de
  // desarrollo de los dos frontends Vite (5173/4173 y 5174/4174) y la propia API.
  CORS_ORIGIN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Variables de entorno invalidas:', parsed.error.flatten().fieldErrors);
  throw new Error('Configuracion de entorno invalida. Revisa tu archivo .env (ver .env.example).');
}

const env = parsed.data;

/**
 * Una clave de Anthropic real empieza por "sk-ant-" y tiene longitud considerable.
 * El placeholder del .env.example ("sk-ant-xxxx...") no es válido: lo tratamos
 * como ausente para que Carmen entre en modo degradado limpio (solo RAG) en vez
 * de intentar una llamada que fallaría por autenticación.
 */
function normalizarAnthropicKey(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v.startsWith('sk-ant-') || /x{6,}/i.test(v) || v.length < 40) return undefined;
  return v;
}

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  allowInsecureDevAuth: env.NODE_ENV === 'development' && env.ALLOW_INSECURE_DEV_AUTH === '1',
  databaseUrl: env.DATABASE_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  jwtSecret: env.JWT_SECRET,
  fsApiUrl: env.FS_API_URL,
  fsApiKey: env.FS_API_KEY,
  anthropicApiKey: normalizarAnthropicKey(env.ANTHROPIC_API_KEY),
  carmen: {
    llmActivo: env.CARMEN_LLM_ACTIVO === 'true',
    modelo: env.CARMEN_MODELO,
    topeMensualEur: env.CARMEN_TOPE_MENSUAL_EUR,
    topeEmpresaDia: env.CARMEN_TOPE_EMPRESA_DIA,
    topeUsuarioDia: env.CARMEN_TOPE_USUARIO_DIA,
    mensajesUsuarioDia: env.CARMEN_MENSAJES_USUARIO_DIA,
    maxTokensSalida: env.CARMEN_MAX_TOKENS_SALIDA,
  },
  cronSecret: env.CRON_SECRET,
  corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:4173,http://localhost:5174,http://localhost:4174,http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;
