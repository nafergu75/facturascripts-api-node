import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // BD propia (MySQL via Prisma)
  DATABASE_URL: z.string().min(1),

  // Clave de cifrado AES-256-GCM: 32 bytes en hex (64 caracteres)
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 64 caracteres hex (32 bytes)'),

  // Secreto JWT de la capa Node
  JWT_SECRET: z.string().min(1),

  // FacturaScripts por defecto (solo lo usa el seed; en runtime cada empresa trae los suyos)
  FS_API_URL: z.string().url().optional(),
  FS_API_KEY: z.string().optional(),

  // Claude API (Anthropic) - Para el asistente "Carmen". Opcional: sin ella,
  // el endpoint de chat sigue funcionando en modo degradado (solo RAG, sin LLM).
  ANTHROPIC_API_KEY: z.string().optional(),

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
  databaseUrl: env.DATABASE_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  jwtSecret: env.JWT_SECRET,
  fsApiUrl: env.FS_API_URL,
  fsApiKey: env.FS_API_KEY,
  anthropicApiKey: normalizarAnthropicKey(env.ANTHROPIC_API_KEY),
  corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:4173,http://localhost:5174,http://localhost:4174,http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;
