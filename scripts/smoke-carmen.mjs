/**
 * Smoke test e2e de Carmen (T4) contra un despliegue real (Vercel) o local.
 *
 * Verifica de un golpe:
 *   - T2 (RAG en serverless): la respuesta trae `sources` (el indice se cargo /
 *     reconstruyo en memoria; si llegaran 0 fuentes, el RAG arranco vacio).
 *   - T3 (LLM real): detecta si Carmen responde con Claude o en modo degradado
 *     (sin ANTHROPIC_API_KEY), mirando el centinela del fallback local.
 *
 * Uso:
 *   node scripts/smoke-carmen.mjs https://conta-api.vercel.app
 *   CONTA_API_URL=https://... CARMEN_EMAIL=demo@empresa.com CARMEN_PASS=demo1234 \
 *     node scripts/smoke-carmen.mjs
 *
 * No requiere dependencias (fetch global de Node 18+). Exit 0 = OK, 1 = fallo.
 */

const BASE = (process.argv[2] || process.env.CONTA_API_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.CARMEN_EMAIL || 'demo@empresa.com';
const PASS = process.env.CARMEN_PASS || 'demo1234';
const PREGUNTA = process.env.CARMEN_PREGUNTA || '¿Cuándo se declara el IVA y dónde veo mis libros de IVA en la app?';

// Centinela del modo degradado (assistant-engine.buildFallbackResponse).
const SENTINELA_SIN_KEY = 'Carmen aún no tiene a Claude configurado';
const SENTINELA_ERROR_LLM = 'No he podido conectar con el motor de IA';

function abort(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function callJson(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  if (!BASE) {
    abort('Falta la URL base. Uso: node scripts/smoke-carmen.mjs https://tu-deploy.vercel.app');
  }
  console.log(`▶ Smoke Carmen contra ${BASE}`);

  // 0) Health (sanity check del deploy)
  const health = await callJson('GET', '/health');
  console.log(`  /health -> ${health.status}`);
  if (health.status !== 200) abort(`/health no responde 200 (status ${health.status}). ¿URL/deploy correctos?`);

  // 1) Login
  const login = await callJson('POST', '/auth/login', { body: { email: EMAIL, password: PASS } });
  if (login.status !== 200 || !login.json?.data?.token) {
    abort(`Login fallo (status ${login.status}): ${JSON.stringify(login.json)}`);
  }
  const { token, empresas, empresaSeleccionada } = login.json.data;
  const companyId = empresaSeleccionada || empresas?.[0]?.companyId;
  if (!companyId) abort('El usuario no tiene ninguna empresa asociada (empresas vacio).');
  console.log(`  login OK -> companyId=${companyId}`);

  // 2) Chat
  const chat = await callJson('POST', `/companies/${companyId}/chat-assistant`, {
    token,
    body: { message: PREGUNTA, sessionId: `smoke-${Date.now()}`, currentPage: '/impuestos' },
  });
  if (chat.status !== 200 || !chat.json?.data) {
    abort(`chat-assistant fallo (status ${chat.status}): ${JSON.stringify(chat.json)}`);
  }
  const { response, sources, suggestions, sessionId } = chat.json.data;
  console.log(`  chat OK -> sessionId=${sessionId}, sources=${sources?.length ?? 0}, suggestions=${suggestions?.length ?? 0}`);

  // 3) Diagnostico T2 (RAG)
  const ragOk = Array.isArray(sources) && sources.length > 0;
  console.log(`\n  ${ragOk ? '✅' : '⚠️ '} T2 RAG: ${ragOk ? `${sources.length} fuentes recuperadas` : 'SIN fuentes (indice vacio en prod)'}`);
  if (ragOk) console.log(`     fuentes: ${sources.map((s) => s.source).join(', ')}`);

  // 4) Diagnostico T3 (LLM vs degradado)
  // OJO orden: el fallback de error EMBEBE el texto de "sin key", asi que hay
  // que comprobar el centinela de error ANTES que el de "sin key".
  const errorLlm = response.includes(SENTINELA_ERROR_LLM);
  const degradadoSinKey = !errorLlm && response.includes(SENTINELA_SIN_KEY);
  let modo;
  if (errorLlm) modo = 'KEY presente pero la llamada a Claude fallo (revisar key/cuota/acceso a Opus/logs)';
  else if (degradadoSinKey) modo = 'DEGRADADO (sin ANTHROPIC_API_KEY) — falta T3';
  else modo = 'LLM REAL (Claude respondio)';
  console.log(`  ${degradadoSinKey || errorLlm ? '⚠️ ' : '✅'} T3 LLM: ${modo}`);

  console.log('\n--- Respuesta de Carmen (primeros 400 chars) ---');
  console.log(response.slice(0, 400) + (response.length > 400 ? '…' : ''));

  // El smoke "pasa" si al menos el pipeline e2e responde con RAG. El modo LLM es
  // informativo: en degradado el exit sigue siendo 0 (Carmen funciona), pero lo
  // marcamos para que sepas que falta configurar la key.
  if (!ragOk) abort('RAG sin fuentes: T2 no esta surtiendo efecto en este deploy.');
  console.log('\n✅ Smoke e2e OK (pipeline login -> scope -> RAG -> respuesta).');
  if (degradadoSinKey) console.log('ℹ️  Aun en modo degradado: completa T3 (ANTHROPIC_API_KEY en Vercel) y redeploy.');
  if (errorLlm) console.log('ℹ️  La key esta puesta pero Claude rechaza la llamada: revisa que la key sea valida (no revocada), con credito/billing y acceso a Opus 4.8. Mira `vercel logs`.');
}

main().catch((e) => abort(e?.stack || String(e)));
