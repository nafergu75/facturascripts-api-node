/**
 * Empresas de pruebas de VERI*FACTU (spec verifactu, 12.1; plan F2, bloque F).
 *
 * Para la bateria de pruebas en el entorno de preproduccion de la AEAT, cada
 * sociedad real tiene (si el administrador global la crea) una empresa de
 * pruebas con su mismo NIF y denominacion: «<nombre> (PRUEBAS)». Asi nunca se
 * generan registros de pruebas sobre facturas reales, y el QR de una factura
 * entregada a un cliente nunca apunta a prewww2.
 *
 *  - Company.pruebasVerifactuDe = id de la real (unico: una de pruebas por real).
 *  - Copia los datos legales de la real; AjustesFiscales sin SII y con el
 *    criterio de caja de la real (cambia la clave de regimen).
 *  - Series propias PRU<AAMMDD> (facturas), PRR<AAMMDD> (rectificativas) y
 *    PRT<AAMMDD> (rectificativas de tickets), del dia de alta en Madrid: si la
 *    bateria se repite otro dia, los numeros no chocan con los de antes en la AEAT.
 *  - VerifactuConfig en PRUEBAS/PRUEBAS. Solo el entorno de pruebas
 *    (registro.service, exigirEntornoPermitido).
 *  - Sube su propio certificado (el mismo fichero, otra vez): el cifrado va
 *    ligado a cada empresa.
 *
 * Todo en una transaccion, con `tx` y una consulta detras de otra.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { conflict, notFound } from '../../utils/http-errors';
import { formatearHusoMadrid, hoyEspana } from '../../utils/fechas';
import { perfilDesdeConfig } from '../perfilEmpresa.service';
import { comprobarNifLibre, esConflictoEscritura } from '../legalConfig.service';
import type { EmpresaAdmin } from '../../domain/admin.model';

export const CODIGO_ES_DE_PRUEBAS = 'VERIFACTU_ES_DE_PRUEBAS';
export const CODIGO_NO_APLICA = 'VERIFACTU_NO_APLICA';
export const CODIGO_DATOS_OBLIGADO = 'VERIFACTU_DATOS_OBLIGADO';
export const CODIGO_YA_TIENE_PRUEBAS = 'VERIFACTU_YA_TIENE_PRUEBAS';

const SUFIJO = ' (PRUEBAS)';
const NOMBRE_MAX = 120;

/** «IFBIOSOLUCIONES» -> «IFBIOSOLUCIONES (PRUEBAS)», como mucho 120 caracteres. */
export function nombreEmpresaPruebas(nombreReal: string): string {
  const base = Array.from(nombreReal.trim().replace(/\s+/g, ' '))
    .slice(0, NOMBRE_MAX - SUFIJO.length)
    .join('')
    .trim();
  return `${base}${SUFIJO}`;
}

/** Codigos de las series de la empresa de pruebas para el dia `hoy` (AAAA-MM-DD). */
export function seriesEmpresaPruebas(hoy: string): { facturas: string; rectificativas: string; tickets: string } {
  const aammdd = hoy.slice(2).replace(/-/g, '');
  return { facturas: `PRU${aammdd}`, rectificativas: `PRR${aammdd}`, tickets: `PRT${aammdd}` };
}

const conCodigo = (codigo: string, extra: Record<string, unknown> = {}) => ({ codigo, code: codigo, ...extra });

const esDuplicado = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002';

/**
 * Crea la empresa de pruebas de la empresa real `realId`. La crea el
 * administrador global (la ruta pide admin:global), que queda como
 * administrador de ella. Devuelve la empresa como la lista de /admin.
 */
export async function crearEmpresaPruebas(realId: string, creadorId: string, ahora: Date = new Date()): Promise<EmpresaAdmin & { pruebasVerifactuDe: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const real = await tx.company.findUnique({ where: { id: realId }, select: { id: true, name: true, pruebasVerifactuDe: true } });
      if (!real) throw notFound('Empresa no encontrada.');
      if (real.pruebasVerifactuDe) {
        throw conflict('Esta ya es una empresa de pruebas de VERI*FACTU: la empresa de pruebas se crea desde la empresa real.', conCodigo(CODIGO_ES_DE_PRUEBAS));
      }
      const legal = await tx.legalConfig.findUnique({ where: { companyId: realId } });
      if (!perfilDesdeConfig(legal).espanola) {
        throw conflict('VERI*FACTU solo se aplica a empresas españolas: esta empresa no necesita empresa de pruebas.', conCodigo(CODIGO_NO_APLICA));
      }
      const config = await tx.verifactuConfig.findUnique({ where: { companyId: realId }, select: { motivoExclusion: true } });
      if (config?.motivoExclusion) {
        throw conflict('Esta empresa está fuera de VERI*FACTU (SII o régimen foral): no necesita empresa de pruebas.', conCodigo(CODIGO_NO_APLICA));
      }
      const faltan = [!legal?.denominacion?.trim() ? 'denominacion' : null, !legal?.nif?.trim() ? 'nif' : null].filter((x): x is string => !!x);
      if (!legal || faltan.length) {
        throw conflict('Antes de crear la empresa de pruebas, completa la denominación y el NIF de la empresa en Datos de la empresa.', conCodigo(CODIGO_DATOS_OBLIGADO, { campos: faltan }));
      }
      const ya = await tx.company.findUnique({ where: { pruebasVerifactuDe: realId }, select: { id: true, name: true } });
      if (ya) {
        throw conflict(`Esta empresa ya tiene su empresa de pruebas de VERI*FACTU: «${ya.name}».`, conCodigo(CODIGO_YA_TIENE_PRUEBAS, { empresaPruebasId: ya.id }));
      }
      // Ninguna otra empresa (salvo la real) puede tener ya ese NIF.
      await comprobarNifLibre(tx, legal.nif!, undefined, { pruebasDe: realId });

      const nueva = await tx.company.create({
        data: { name: nombreEmpresaPruebas(real.name), codigo: null, fsBaseUrl: '', fsApiKeyEnc: '', isActive: true, pruebasVerifactuDe: realId },
      });
      const creador = await tx.user.findUnique({ where: { id: creadorId }, select: { id: true } });
      if (creador) await tx.membership.create({ data: { userId: creadorId, companyId: nueva.id, role: 'admin' } });

      // Los datos legales de la real, tal cual (los del PDF y los del obligado).
      const { id: _id, companyId: _c, createdAt: _cr, updatedAt: _up, ...datosLegales } = legal;
      void _id;
      void _c;
      void _cr;
      void _up;
      await tx.legalConfig.create({ data: { ...datosLegales, companyId: nueva.id } });
      const ajustesReal = await tx.ajustesFiscales.findUnique({ where: { companyId: realId }, select: { criterioCaja: true } });
      await tx.ajustesFiscales.create({ data: { companyId: nueva.id, sii: false, criterioCaja: ajustesReal?.criterioCaja === true, updatedBy: creadorId } });

      const hoy = hoyEspana(ahora);
      const s = seriesEmpresaPruebas(hoy);
      await tx.invoiceSeries.create({ data: { companyId: nueva.id, codigo: s.facturas, descripcion: 'Facturas de pruebas de VERI*FACTU', tipoDocumento: 'FACTURA', activa: true, porDefecto: true } });
      await tx.invoiceSeries.create({
        data: { companyId: nueva.id, codigo: s.rectificativas, descripcion: 'Rectificativas de pruebas de VERI*FACTU', tipoDocumento: 'RECTIFICATIVA', activa: true, porDefecto: true },
      });
      await tx.invoiceSeries.create({
        data: { companyId: nueva.id, codigo: s.tickets, descripcion: 'Rectificativas de tickets de pruebas de VERI*FACTU', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true },
      });

      await tx.verifactuConfig.create({
        data: { companyId: nueva.id, estado: 'PRUEBAS', entorno: 'PRUEBAS', activadaPor: creadorId, activadaEn: ahora, updatedBy: creadorId },
      });

      const detalle = { empresaReal: realId, empresaPruebas: nueva.id, nombre: nueva.name, nif: legal.nif, series: s, instante: formatearHusoMadrid(ahora) };
      for (const companyId of [nueva.id, realId]) {
        await tx.verifactuBitacora.create({ data: { companyId, tipo: 'EMPRESA_PRUEBAS_CREADA', usuarioId: creadorId, detalle: detalle as Prisma.InputJsonValue } });
        await tx.auditLog.create({
          data: {
            userId: creadorId,
            companyId,
            action: 'VERIFACTU_EMPRESA_PRUEBAS_CREADA',
            resourceType: 'COMPANY',
            resourceId: nueva.id,
            meta: detalle as Prisma.InputJsonValue,
          },
        });
      }

      return {
        id: nueva.id,
        codigo: nueva.codigo,
        nombre: nueva.name,
        activa: nueva.isActive,
        creadoEn: nueva.createdAt.toISOString(),
        denominacion: legal.denominacion,
        nif: legal.nif,
        pais: legal.pais,
        usuarios: creador ? 1 : 0,
        pruebasVerifactuDe: realId,
      };
    });
  } catch (e) {
    // El indice unico de pruebasVerifactuDe es la ultima defensa ante dos altas a la vez.
    if (esDuplicado(e)) {
      const ya = await prisma.company.findUnique({ where: { pruebasVerifactuDe: realId }, select: { id: true, name: true } });
      throw conflict(`Esta empresa ya tiene su empresa de pruebas de VERI*FACTU${ya ? `: «${ya.name}»` : ''}.`, conCodigo(CODIGO_YA_TIENE_PRUEBAS, { empresaPruebasId: ya?.id ?? null }));
    }
    if (esConflictoEscritura(e)) {
      throw conflict('Se estaba creando a la vez otra empresa con el mismo NIF. Vuelve a intentarlo en unos segundos.', conCodigo(CODIGO_YA_TIENE_PRUEBAS));
    }
    throw e;
  }
}
