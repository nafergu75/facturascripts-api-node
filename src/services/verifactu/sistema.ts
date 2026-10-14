/**
 * Identificacion del sistema informatico de facturacion que va en cada
 * registro (bloque SistemaInformatico; spec verifactu, 11.1).
 *
 * - NumeroInstalacion: 'CONTA-' + companyId. En un SIF SaaS cada facturacion es
 *   un «SIF virtual» con su propio numero, que no se repite nunca (FAQ de
 *   desarrolladores de la AEAT v1.3, 4-12-2025, n.º 4).
 * - IndicadorMultiplesOT: «S» si el usuario del SaaS tiene mas de una
 *   facturacion, en cualquier estado (misma FAQ, n.º 4). La app no separa
 *   usuarios de la plataforma: se toma «S» si hay mas de una empresa.
 * - VERSION_SIF es propia de VERI*FACTU: sube con cada cambio que afecte a los
 *   registros y pasa a 1.0.0 con la declaracion responsable (fase F5).
 * - El productor es la entidad desarrolladora (decision del usuario del
 *   11-10-2026: IFBIOSOLUCIONES, S.A., NIF A10952364); el nombre exacto esta
 *   pendiente de confirmar (pregunta 2 de la spec).
 */
import { nifEmpresaDesarrollo } from '../../aeat/common/cabeceraAux';
import type { SistemaInformatico } from './tipos';

export const NOMBRE_SISTEMA = 'Conta API';
/** Dos posiciones: mayuscula (sin Ñ) o cifra (Validaciones v1.2.2, 3.1.5). */
export const ID_SISTEMA = 'CA';
export const VERSION_SIF = '0.1.0';
export const NOMBRE_PRODUCTOR = 'IFBIOSOLUCIONES, S.A.';

/** Productor del sistema: nombre y NIF (el de la entidad desarrolladora de los modelos de la AEAT). */
export function productor(): { nombreRazon: string; nif: string } {
  return { nombreRazon: NOMBRE_PRODUCTOR, nif: nifEmpresaDesarrollo() };
}

/** NumeroInstalacion de la facturacion de una empresa (como mucho 100 caracteres). */
export function numeroInstalacionDe(companyId: string): string {
  const n = `CONTA-${companyId}`;
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
