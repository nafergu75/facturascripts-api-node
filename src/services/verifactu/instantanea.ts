/**
 * Instantanea de la emision (IncomeInvoice.instantaneaEmision; spec verifactu,
 * 2.8 y 5.3): los datos del emisor (LegalConfig) y del cliente (Customer) tal
 * como estaban al emitir. El PDF de una factura emitida los toma de aqui, asi
 * que no cambia si despues se edita la ficha del cliente o los datos de la
 * empresa, y el nombre del emisor del registro de VERI*FACTU es el de la factura.
 *
 * Se rellena en TODA emision de la app (directa y al finalizar un borrador),
 * tambien sin VERI*FACTU y en empresas extranjeras. No en el lector: su PDF es
 * el original.
 */
import type { Prisma } from '@prisma/client';
import type { TransaccionBD } from '../../config/database';
import { textoInscripcionRegistral } from '../legalConfig.service';

export interface EmisorInstantanea {
  denominacion: string | null;
  nif: string | null;
  domicilioSocial: string | null;
  codigoPostal: string | null;
  municipio: string | null;
  provincia: string | null;
  pais: string | null;
  telefono: string | null;
  email: string | null;
  web: string | null;
  inscripcion: string | null;
  /**
   * Texto libre de los datos registrales y provincia del Registro Mercantil: las
   * plantillas A y B escriben con ellos su linea «Inscrita en el Registro
   * Mercantil de ...». Opcionales: una instantanea sin ellos usa `inscripcion`.
   */
  datosRegistrales?: string | null;
  registroMercantilProvincia?: string | null;
}

export interface ClienteInstantanea {
  nombreFiscal: string;
  nifCif: string | null;
  direccion: string | null;
  cp: string | null;
  municipio: string | null;
  provincia: string | null;
  pais: string | null;
}

export interface Instantanea {
  v: 1;
  emisor: EmisorInstantanea;
  cliente: ClienteInstantanea;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Lee el emisor y el cliente dentro de la transaccion de emision, una consulta
 * detras de otra (con una sola conexion no se usa el cliente global ni Promise.all).
 */
export async function instantaneaDeEmision(tx: TransaccionBD, companyId: string, customerId: string): Promise<Instantanea> {
  const legal = await tx.legalConfig.findUnique({ where: { companyId } });
  const cliente = await tx.customer.findFirst({ where: { id: customerId, companyId } });
  if (!cliente) throw new Error(`Cliente ${customerId} no encontrado al emitir.`);
  return {
    v: 1,
    emisor: {
      denominacion: texto(legal?.denominacion),
      nif: texto(legal?.nif),
      domicilioSocial: texto(legal?.domicilioSocial),
      codigoPostal: texto(legal?.codigoPostal),
      municipio: texto(legal?.municipio),
      provincia: texto(legal?.provincia),
      pais: texto(legal?.pais),
      telefono: texto(legal?.telefono),
      email: texto(legal?.email),
      web: texto(legal?.web),
      inscripcion: textoInscripcionRegistral(legal as unknown as Record<string, unknown> | null),
      datosRegistrales: texto(legal?.datosRegistrales),
      registroMercantilProvincia: texto(legal?.registroMercantilProvincia),
    },
    cliente: {
      nombreFiscal: cliente.nombreFiscal,
      nifCif: texto(cliente.nifCif),
      direccion: texto(cliente.direccion),
      cp: texto(cliente.cp),
      municipio: texto(cliente.municipio),
      provincia: texto(cliente.provincia),
      pais: texto(cliente.pais),
    },
  };
}

/** Para guardarla en la columna Json. */
export const instantaneaComoJson = (i: Instantanea): Prisma.InputJsonValue => i as unknown as Prisma.InputJsonValue;

const esTextoONull = (v: unknown) => v === null || v === undefined || typeof v === 'string';

/** La instantanea guardada, comprobada; null si no hay o no tiene la forma esperada (se usan los datos de ahora). */
export function leerInstantanea(json: unknown): Instantanea | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  if (j.v !== 1) return null;
  const e = j.emisor as Record<string, unknown> | null;
  const c = j.cliente as Record<string, unknown> | null;
  if (!e || typeof e !== 'object' || !c || typeof c !== 'object') return null;
  // Los dos ultimos llegaron con las plantillas A y B: en una instantanea anterior faltan y quedan en null.
  const camposEmisor = [
    'denominacion',
    'nif',
    'domicilioSocial',
    'codigoPostal',
    'municipio',
    'provincia',
    'pais',
    'telefono',
    'email',
    'web',
    'inscripcion',
    'datosRegistrales',
    'registroMercantilProvincia',
  ];
  const camposCliente = ['nifCif', 'direccion', 'cp', 'municipio', 'provincia', 'pais'];
  if (!camposEmisor.every((k) => esTextoONull(e[k]))) return null;
  if (typeof c.nombreFiscal !== 'string' || !camposCliente.every((k) => esTextoONull(c[k]))) return null;
  const t = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    v: 1,
    emisor: Object.fromEntries(camposEmisor.map((k) => [k, t(e, k)])) as unknown as EmisorInstantanea,
    cliente: { nombreFiscal: c.nombreFiscal, ...(Object.fromEntries(camposCliente.map((k) => [k, t(c, k)])) as Omit<ClienteInstantanea, 'nombreFiscal'>) },
  };
}
