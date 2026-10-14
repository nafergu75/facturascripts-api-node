/**
 * Cliente SOAP de los servicios de VERI*FACTU de la AEAT (spec verifactu, 6.1
 * y 6.2; WSDL tikeV1.0). SOAP 1.1 document/literal sobre TLS con certificado
 * de cliente.
 *
 *  - Nunca dentro de una transaccion (ni red ni descifrado dentro).
 *  - Doble candado: la URL de la AEAT de verdad (www1/www10) solo con
 *    config.verifactu.produccion (VERIFACTU_PRODUCCION=si y NODE_ENV=production).
 *    Sin el, urlServicio('PRODUCCION') lanza: nunca devuelve una URL de www.
 *  - El servidor se comprueba siempre: nunca se apaga la comprobacion de TLS.
 *  - Los SOAP Fault llegan con HTTP 500: se devuelven como respuesta para
 *    clasificarlos (respuestas.ts), no como error.
 *
 * Solo en los tests (NODE_ENV=test) se puede cambiar el destino por un
 * servidor HTTPS local, con su CA (fijarDestinoParaTests).
 */
import https from 'https';
import axios from 'axios';
import { config } from '../../config/env';
import { dentroDeTransaccion } from '../../config/guardaTransaccion';
import type { EntornoVerifactu } from './cadena';

const RUTA = '/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP';

/** URLs del WSDL (SistemaFacturacion.wsdl): certificado normal y certificado de sello. */
export const URL_SERVICIO: Record<EntornoVerifactu, { normal: string; sello: string }> = {
  PRUEBAS: { normal: `https://prewww1.aeat.es${RUTA}`, sello: `https://prewww10.aeat.es${RUTA}` },
  PRODUCCION: { normal: `https://www1.agenciatributaria.gob.es${RUTA}`, sello: `https://www10.agenciatributaria.gob.es${RUTA}` },
};

/** Tope del cuerpo de una respuesta. */
export const MAX_RESPUESTA_BYTES = 5 * 1024 * 1024;

let destinoTests: { url: string; ca?: string | Buffer } | null = null;

/** Solo en los tests: el destino de todas las llamadas (un servidor HTTPS local) y su CA. */
export function fijarDestinoParaTests(d: { url: string; ca?: string | Buffer } | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('fijarDestinoParaTests solo se puede usar en los tests.');
  destinoTests = d;
}

/** URL del servicio del entorno. PRODUCCION solo con el doble candado abierto. */
export function urlServicio(entorno: EntornoVerifactu, o: { sello: boolean }, cfg: { produccion: boolean } = config.verifactu): string {
  if (entorno === 'PRODUCCION' && !cfg.produccion) {
    const e = new Error('VERI*FACTU: el envío a la AEAT de verdad está bloqueado en este despliegue (VERIFACTU_PRODUCCION).');
    (e as Error & { code?: string }).code = 'VERIFACTU_PRODUCCION_BLOQUEADA';
    throw e;
  }
  const u = URL_SERVICIO[entorno];
  if (!u) throw new Error(`VERI*FACTU: entorno desconocido (${entorno}).`);
  return o.sello ? u.sello : u.normal;
}

export interface RespuestaSoap {
  status: number;
  tipoContenido: string | null;
  cuerpo: string;
  ms: number;
}

/**
 * Envia un sobre SOAP con el certificado de cliente. Devuelve la respuesta HTTP
 * (sea cual sea su codigo) o lanza el error de red tal cual, para clasificarlo.
 */
export async function enviarSoap(o: { url: string; pfx: Buffer; passphrase: string; sobre: string; timeoutMs: number; ca?: string | Buffer }): Promise<RespuestaSoap> {
  if (dentroDeTransaccion()) throw new Error('VERI*FACTU: no se llama a la AEAT dentro de una transacción.');
  const url = destinoTests?.url ?? o.url;
  const ca = destinoTests?.ca ?? o.ca;
  const agente = new https.Agent({ pfx: o.pfx, passphrase: o.passphrase, keepAlive: false, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) });
  const inicio = Date.now();
  try {
    const r = await axios.post<string>(url, o.sobre, {
      httpsAgent: agente,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      timeout: o.timeoutMs,
      signal: AbortSignal.timeout(o.timeoutMs),
      maxRedirects: 0,
      proxy: false,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
      validateStatus: () => true,
      maxContentLength: MAX_RESPUESTA_BYTES,
      maxBodyLength: MAX_RESPUESTA_BYTES,
    });
    const tipo = r.headers?.['content-type'];
    return { status: r.status, tipoContenido: typeof tipo === 'string' ? tipo : null, cuerpo: typeof r.data === 'string' ? r.data : String(r.data ?? ''), ms: Date.now() - inicio };
  } finally {
    agente.destroy();
  }
}
