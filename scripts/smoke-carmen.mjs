/**
 * Smoke test de Carmen contra un despliegue (Vercel) o un servidor local.
 *
 * Comprueba:
 *   - /health responde y dice si la IA de Carmen está encendida (sin importes);
 *   - una pregunta de datos se responde con los datos de la app (origen 'datos'),
 *     o con el aviso de permisos si el usuario no los tiene, sin pasar por la IA;
 *   - una pregunta frecuente se responde con su ficha y su fuente (origen 'faq');
 *   - una pregunta que no entiende devuelve botones (origen 'aclaracion');
 *   - /estado dice si la IA está disponible y por qué no.
 *
 * Uso (las credenciales SIEMPRE por variables de entorno, nunca en el código):
 *   CARMEN_EMAIL=... CARMEN_PASS=... node scripts/smoke-carmen.mjs https://tu-api.vercel.app
 *
 * Sin dependencias (fetch de Node 18+). Exit 0 = OK, 1 = fallo.
 */

const BASE = (process.argv[2] || process.env.CONTA_API_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.CARMEN_EMAIL;
const PASS = process.env.CARMEN_PASS;

function abortar(msg) {
  console.error(`\nFALLO: ${msg}`);
  process.exit(1);
}

async function llamar(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  if (!BASE) abortar('Falta la URL base. Uso: node scripts/smoke-carmen.mjs https://tu-api.vercel.app');
  if (!EMAIL || !PASS) abortar('Faltan CARMEN_EMAIL y CARMEN_PASS en las variables de entorno.');
  console.log(`Smoke de Carmen contra ${BASE}`);

  const health = await llamar('GET', '/health');
  if (health.status !== 200) abortar(`/health devuelve ${health.status}.`);
  console.log(`  /health OK; carmen: ${JSON.stringify(health.json?.carmen ?? null)}`);

  const login = await llamar('POST', '/auth/login', { body: { email: EMAIL, password: PASS } });
  if (login.status !== 200 || !login.json?.data?.token) abortar(`login falla (${login.status}).`);
  const { token, empresas, empresaSeleccionada } = login.json.data;
  const companyId = empresaSeleccionada || empresas?.[0]?.companyId;
  if (!companyId) abortar('El usuario no tiene ninguna empresa.');
  const ruta = `/companies/${companyId}/chat-assistant`;

  const casos = [
    { nombre: 'pregunta de datos', message: '¿Cuánto dinero tengo en el banco?', origenes: ['datos', 'sistema'] },
    { nombre: 'pregunta frecuente', message: '¿Cómo apruebo los asientos?', origenes: ['faq'], conFuente: true },
    { nombre: 'pregunta no entendida', message: 'zxq wpl', origenes: ['aclaracion'], conBotones: true },
  ];
  let sessionId;
  for (const c of casos) {
    const r = await llamar('POST', ruta, { token, body: { message: c.message, ...(sessionId ? { sessionId } : {}), currentPage: '/dashboard' } });
    if (r.status !== 200 || !r.json?.data) abortar(`${c.nombre}: estado ${r.status} ${JSON.stringify(r.json)}`);
    const d = r.json.data;
    sessionId = d.sessionId;
    if (!c.origenes.includes(d.origen)) abortar(`${c.nombre}: origen ${d.origen}, se esperaba ${c.origenes.join(' o ')}.`);
    if (d.origen === 'ia') abortar(`${c.nombre}: ha respondido la IA y no debía.`);
    if (c.conFuente && !d.fuente?.url) abortar(`${c.nombre}: la ficha no trae fuente.`);
    if (c.conBotones && !(d.botones?.length > 0)) abortar(`${c.nombre}: la aclaración no trae botones.`);
    console.log(`  ${c.nombre}: OK (origen ${d.origen}${d.intencion ? `, ${d.intencion}` : ''})`);
  }

  const estado = await llamar('GET', `${ruta}/estado`, { token });
  if (estado.status !== 200) abortar(`/estado devuelve ${estado.status}.`);
  console.log(`  /estado: iaDisponible=${estado.json.data.iaDisponible}${estado.json.data.motivo ? ` (${estado.json.data.motivo})` : ''}`);

  const historial = await llamar('GET', `${ruta}/${sessionId}/messages`, { token });
  if (historial.status !== 200) abortar(`historial devuelve ${historial.status}.`);
  const borrar = await llamar('DELETE', `${ruta}/${sessionId}`, { token });
  if (borrar.status !== 200) abortar(`borrar la conversación devuelve ${borrar.status}.`);
  console.log('  historial y borrado: OK');
  console.log('\nSmoke de Carmen OK.');
}

main().catch((e) => abortar(e?.stack || String(e)));
