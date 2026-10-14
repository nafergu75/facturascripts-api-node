/**
 * Para los tests: marca una empresa como empresa de pruebas de VERI*FACTU
 * (Company.pruebasVerifactuDe). Desde la fase F2 el estado PRUEBAS solo vale en
 * una empresa de pruebas (registro.service, exigirEntornoPermitido): un test
 * que pone PRUEBAS en una empresa corriente recibiria 409
 * VERIFACTU_ENTORNO_NO_PERMITIDO al emitir.
 *
 * Sin `realId`, una referencia ficticia y unica por empresa (la columna no
 * tiene clave ajena; es unica y de 30 caracteres como mucho).
 */
import { createHash } from 'crypto';
import type { ClienteBD } from '../config/database';

export async function marcarEmpresaPruebas(db: ClienteBD, companyId: string, realId?: string): Promise<void> {
  const de = realId ?? `fx-${createHash('sha1').update(companyId).digest('hex').slice(0, 24)}`;
  await db.company.update({ where: { id: companyId }, data: { pruebasVerifactuDe: de } });
}
