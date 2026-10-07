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

  // Carmen y CRON_SECRET se leen aparte (leerCarmen): una errata en ellas no
  // impide arrancar la API; deja la IA apagada o el cron sin configurar.

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

// ---------------- Carmen y tareas programadas ----------------
//
// Van fuera de envSchema a proposito: si fallaran ahi, una errata en una opcion
// de Carmen (que viene apagada) tumbaria la API entera, login incluido. Aqui un
// valor no valido se avisa en el log y deja el modo seguro: la IA APAGADA (asi
// tampoco cambia el gasto sin avisar) y, si es CRON_SECRET, el cron sin
// configurar (responde 503).

const MODELOS_CARMEN = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'] as const;
type ModeloCarmen = (typeof MODELOS_CARMEN)[number];

/** Admite la coma decimal ("2,5"). */
const numeroCarmen = (opciones: { entero?: boolean; max?: number } = {}) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().replace(',', '.') : v),
    (opciones.entero ? z.coerce.number().int() : z.coerce.number()).positive().max(opciones.max ?? Number.MAX_SAFE_INTEGER),
  );

const carmenSchema = z.object({
  // Solo Haiku 4.5: los topes y la reserva por pregunta estan pensados para su precio.
  CARMEN_MODELO: z.enum(MODELOS_CARMEN).default('claude-haiku-4-5-20251001'),
  // Tope de gasto de la IA en el mes, para todas las empresas juntas (euros, 1 $ = 1 €).
  CARMEN_TOPE_MENSUAL_EUR: numeroCarmen().default(5),
  // Preguntas a la IA por dia: por empresa y por usuario.
  CARMEN_TOPE_EMPRESA_DIA: numeroCarmen({ entero: true }).default(100),
  CARMEN_TOPE_USUARIO_DIA: numeroCarmen({ entero: true }).default(15),
  // Mensajes a Carmen por usuario y dia, de cualquier tipo (freno contra abusos).
  CARMEN_MENSAJES_USUARIO_DIA: numeroCarmen({ entero: true }).default(300),
  // Tokens de salida de cada respuesta de la IA (500 como maximo).
  CARMEN_MAX_TOKENS_SALIDA: numeroCarmen({ entero: true, max: 500 }).default(500),
});
const CARMEN_POR_DEFECTO = carmenSchema.parse({});

interface ConfigCarmen {
  llmActivo: boolean;
  modelo: ModeloCarmen;
  topeMensualEur: number;
  topeEmpresaDia: number;
  topeUsuarioDia: number;
  mensajesUsuarioDia: number;
  maxTokensSalida: number;
}

/** Variables vacias = sin definir (en Vercel o en un .env se quedan a veces como ""). */
function sinVacias(fuente: NodeJS.ProcessEnv): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(fuente)) if (v !== undefined && v.trim() !== '') r[k] = v;
  return r;
}

export function leerCarmen(fuente: NodeJS.ProcessEnv = process.env): { carmen: ConfigCarmen; cronSecret: string | undefined } {
  const vars = sinVacias(fuente);
  /* eslint-disable no-console */
  // Interruptor general de la IA: solo 'true' (sin mirar mayusculas ni espacios) la enciende.
  const interruptor = (vars.CARMEN_LLM_ACTIVO ?? 'false').trim().toLowerCase();
  let llmActivo = interruptor === 'true';
  if (interruptor !== 'true' && interruptor !== 'false') {
    console.error(`CARMEN_LLM_ACTIVO no vale 'true' ni 'false': la IA de Carmen queda apagada.`);
  }

  const leidas = carmenSchema.safeParse(vars);
  let opciones = CARMEN_POR_DEFECTO;
  if (leidas.success) {
    opciones = leidas.data;
  } else {
    // Se usan los valores por defecto, pero la IA se apaga: nada de gasto con una configuracion dudosa.
    console.error('Variables de Carmen invalidas (se usan las de por defecto y la IA queda apagada):', Object.keys(leidas.error.flatten().fieldErrors).join(', '));
    llmActivo = false;
  }

  // Vercel Cron manda "Authorization: Bearer <CRON_SECRET>". Corto = sin configurar.
  let cronSecret: string | undefined = vars.CRON_SECRET;
  if (cronSecret !== undefined && cronSecret.length < 16) {
    console.error('CRON_SECRET tiene menos de 16 caracteres: las tareas programadas quedan sin configurar (responden 503).');
    cronSecret = undefined;
  }
  /* eslint-enable no-console */

  return {
    carmen: {
      llmActivo,
      modelo: opciones.CARMEN_MODELO,
      topeMensualEur: opciones.CARMEN_TOPE_MENSUAL_EUR,
      topeEmpresaDia: opciones.CARMEN_TOPE_EMPRESA_DIA,
      topeUsuarioDia: opciones.CARMEN_TOPE_USUARIO_DIA,
      mensajesUsuarioDia: opciones.CARMEN_MENSAJES_USUARIO_DIA,
      maxTokensSalida: opciones.CARMEN_MAX_TOKENS_SALIDA,
    },
    cronSecret,
  };
}

const carmen = leerCarmen();

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
  carmen: carmen.carmen,
  cronSecret: carmen.cronSecret,
  corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:4173,http://localhost:5174,http://localhost:4174,http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;
