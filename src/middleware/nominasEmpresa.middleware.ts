import type { RequestHandler } from 'express';
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { perfilEmpresa } from '../services/perfilEmpresa.service';

export const MENSAJE_NOMINAS_SOLO_ESPANA =
  'Nóminas es para empresas establecidas en España con la contabilidad en euros: la Seguridad Social, el IRPF y los modelos 111 y 190 son españoles.';

/**
 * Nominas solo para empresas establecidas en Espana con la contabilidad en EUR.
 * Lo que trae la gestoria (SS, IRPF, NIF y NAF espanoles) va en euros y se
 * contabiliza tal cual (640/642/476/4751/465): en una contabilidad en dolares
 * quedaria mezclado. Se aplica a lo que crea o contabiliza (alta, importacion,
 * contabilizar, pagos, seguros sociales, trabajadores). Leer, anular y borrar
 * siguen libres para los datos que ya existan.
 */
export async function comprobarEmpresaParaNominas(companyId: string): Promise<void> {
  // Sin BD (tests con Prisma simulado): no hay perfil que leer.
  const legal = (prisma as { legalConfig?: { findUnique?: unknown } })?.legalConfig;
  if (typeof legal?.findUnique !== 'function') return;
  const perfil = await perfilEmpresa(companyId);
  if (!perfil.espanola || perfil.monedaCuenta !== 'EUR') throw badRequest(MENSAJE_NOMINAS_SOLO_ESPANA);
}

export const soloEmpresaEspanolaEnEuros: RequestHandler = (req, _res, next) => {
  comprobarEmpresaParaNominas(req.companyId!).then(() => next(), next);
};
