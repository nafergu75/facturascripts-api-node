import { createHash, randomUUID } from 'crypto';
import { HuellaFactura } from '../domain/verifactu.model';

// TODO: persistir en BD. Almacen en memoria, encadenado por empresa.
const store = new Map<string, HuellaFactura[]>(); // companyId -> huellas (orden cronologico)

/**
 * Construye la "cadena original" canonica de una factura (campos relevantes en
 * orden fijo). En Veri*Factu real incluye NIF emisor, numero+serie, fecha,
 * importe total, desglose de impuestos y el hash de la factura ANTERIOR.
 */
export function generarCadenaOriginalFactura(factura: Record<string, unknown>, hashAnterior = ''): string {
  const campos = [
    `nif:${factura.cifnif ?? factura.nif ?? ''}`,
    `serie:${factura.codserie ?? ''}`,
    `numero:${factura.codigo ?? factura.numero ?? factura.idfactura ?? ''}`,
    `fecha:${factura.fecha ?? ''}`,
    `total:${factura.total ?? ''}`,
    `prev:${hashAnterior}`,
  ];
  return campos.join('|');
}

/** Calcula el hash SHA-256 (hex) de la cadena original. */
export function calcularHashFactura(cadenaOriginal: string): string {
  return createHash('sha256').update(cadenaOriginal, 'utf8').digest('hex');
}

/**
 * Registra la huella de una factura, encadenandola con la anterior de la empresa
 * (inalterabilidad). Se llamaria tras crear/modificar una factura.
 */
export async function registrarHuellaFactura(companyId: string, factura: Record<string, unknown>): Promise<HuellaFactura> {
  const previas = store.get(companyId) ?? [];
  const hashAnterior = previas.length ? previas[previas.length - 1].hash : '';
  const cadenaOriginal = generarCadenaOriginalFactura(factura, hashAnterior);
  const hash = calcularHashFactura(cadenaOriginal);

  const huella: HuellaFactura = {
    id: randomUUID(),
    companyId,
    facturaId: String(factura.idfactura ?? factura.codigo ?? ''),
    hash,
    algoritmo: 'SHA256',
    cadenaOriginal,
    hashAnterior: hashAnterior || undefined,
    creadaEn: new Date().toISOString(),
  };
  store.set(companyId, [...previas, huella]);
  return huella;
}

/** Huellas de una factura concreta. */
export async function listarHuellasFactura(companyId: string, facturaId: string): Promise<HuellaFactura[]> {
  return (store.get(companyId) ?? []).filter((h) => h.facturaId === facturaId);
}

// INTEGRACION (facturas.service): tras crearFacturaCliente / editar factura ->
//   await registrarHuellaFactura(companyId, facturaCreada)
// y exponer GET /companies/:companyId/facturas/:id/huellas (ya cableado).
