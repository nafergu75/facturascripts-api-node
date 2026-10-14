/**
 * Identificacion del sistema informatico de facturacion que va en cada
 * registro (bloque SistemaInformatico; spec verifactu, 11.1).
 *
 * - NumeroInstalacion: 'CONTA-' + companyId + '-' + instante en que se fija
 *   (AAAAMMDDhhmmss, UTC). En un SIF SaaS cada facturacion es un «SIF virtual»
 *   con su propio numero, que no se repite nunca para ese obligado; si se
 *   reinstala, numero nuevo, y la AEAT recomienda una marca de tiempo (FAQ de
 *   desarrolladores v1.3, 4-12-2025, n.º 4). Con el instante, si se vacian la
 *   configuracion y la cadena de una empresa (una restauracion, el «TODO A
 *   CERO») y se vuelve a empezar, el nuevo PrimerRegistro lleva otro numero y
 *   la AEAT no lo da por repetido (Validaciones 4.3.1).
 * - IndicadorMultiplesOT: lo calcula el sistema segun los obligados que
 *   contiene en ese momento, en cualquier estado (DsRegistroVeriFactu.xlsx
 *   v1.0, hoja 5); en un SaaS, por usuario del SaaS (FAQ de desarrolladores
 *   v1.3, n.º 4): «S» si ese usuario tiene mas de una facturacion. Hoy toda la
 *   plataforma es de un solo usuario, asi que company.count() > 1 equivale (las
 *   empresas de pruebas de VERI*FACTU tambien cuentan). Si la plataforma pasa a
 *   tener varios clientes, hay que contarlo por cliente.
 * - VERSION_SIF es propia de VERI*FACTU: sube con cada cambio que afecte a los
 *   registros y pasa a 1.0.0 con la declaracion responsable (fase F5).
 * - El productor es la entidad desarrolladora: IFBIOSOLUCIONES, S.A., NIF
 *   A10952364, version 0.1.0 (CONFIRMADO por el usuario el 14-10-2026). Nombre
 *   y NIF son constantes de aqui, juntas: el Id. del sistema va ligado al NIF
 *   del productor (FAQ n.º 4). NO se lee AEAT_NIF_EMPRESA_DESARROLLO (la de los
 *   modelos de la AEAT): cambiar esa variable cambiaria la identidad del
 *   sistema a mitad de cadena.
 */
import type { SistemaInformatico } from './tipos';

export const NOMBRE_SISTEMA = 'Conta API';
/** Dos posiciones: mayuscula (sin Ñ) o cifra (Validaciones v1.2.2, 3.1.5). */
export const ID_SISTEMA = 'CA';
export const VERSION_SIF = '0.1.0';
export const NOMBRE_PRODUCTOR = 'IFBIOSOLUCIONES, S.A.';
export const NIF_PRODUCTOR = 'A10952364';

/** Productor del sistema: nombre y NIF, siempre de la misma fuente. */
export function productor(): { nombreRazon: string; nif: string } {
  return { nombreRazon: NOMBRE_PRODUCTOR, nif: NIF_PRODUCTOR };
}

/** AAAAMMDDhhmmss en UTC. */
const marcaDeTiempo = (d: Date) => d.toISOString().slice(0, 19).replace(/\D/g, '');

/** NumeroInstalacion de la facturacion de una empresa, fijado en `instante` (como mucho 100 caracteres). */
export function numeroInstalacionDe(companyId: string, instante: Date): string {
  const n = `CONTA-${companyId}-${marcaDeTiempo(instante)}`;
  if (n.length > 100) throw new Error(`NumeroInstalacion de mas de 100 caracteres: ${n}`);
  return n;
}

/** Bloque SistemaInformatico de un registro. */
export function sistemaInformatico(d: { numeroInstalacion: string; multiplesOT: boolean }): SistemaInformatico {
  const p = productor();
  return {
    nombreRazon: p.nombreRazon,
    nif: p.nif,
    nombreSistemaInformatico: NOMBRE_SISTEMA,
    idSistemaInformatico: ID_SISTEMA,
    version: VERSION_SIF,
    numeroInstalacion: d.numeroInstalacion,
    tipoUsoPosibleSoloVerifactu: 'S',
    tipoUsoPosibleMultiOT: 'S',
    indicadorMultiplesOT: d.multiplesOT ? 'S' : 'N',
  };
}
