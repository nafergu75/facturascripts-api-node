import { Request } from 'express';

/**
 * Empresa de la ruta /companies/:companyId/..., ya validada por companyScope
 * (req.companyId). No se lee de req.params: en un router sin mergeParams llega
 * undefined, y Prisma ignora un filtro undefined (la consulta abarcaria todas
 * las empresas). Si falta, se corta aqui y no se consulta nada.
 */
export function empresaDeLaRuta(req: Request): string {
  const companyId = req.companyId;
  if (!companyId) throw new Error('Ruta de empresa sin req.companyId: falta companyScope.');
  return companyId;
}
