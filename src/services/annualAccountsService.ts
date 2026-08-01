import { prisma } from '../config/database';
import { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../utils/http-errors';
import { generarPdfA } from '../utils/pdf-a';
import { sha256 } from '../utils/zip';
import { guardarArtefacto } from './registroMercantil.helpers';
import { fiscalYearsService } from './fiscalYears.service';
import { generarCuentasAnuales } from './cuentasAnuales.service';
import { EstadoCuentas, ModeloCuentas, puedeTransicionarCuentas, RESOLUCIONES_CUENTAS } from '../domain/registroMercantil.model';

function ejercicioDe(fy: { label: string; fechaFin: string }): number {
  const n = Number(fy.label);
  if (Number.isFinite(n) && n > 1900) return n;
  return Number(fy.fechaFin.slice(0, 4)) || new Date().getFullYear();
}

export const annualAccountsService = {
  /**
   * Genera las cuentas anuales (balance, PyG, memoria) en JSON interno + un PDF
   * de la memoria. El balance/PyG salen del motor contable real
   * (generarCuentasAnuales, asientos POSTED). La MEMORIA es un stub: en
   * producción se compone con el modelo oficial (normal/abreviado/pyme) del
   * anexo técnico del Ministerio de Justicia.
   */
  async generar(fyId: string, modelo: ModeloCuentas = 'PYME') {
    const fy = await fiscalYearsService.obtener(fyId);
    const ejercicio = ejercicioDe(fy);

    let estados: unknown = {};
    try {
      estados = await generarCuentasAnuales(fy.companyId, ejercicio);
    } catch {
      // Si el motor no puede calcular (sin datos), se deja vacío: la memoria
      // sigue generándose y el usuario completa los estados.
      estados = { aviso: 'No se pudieron calcular los estados financieros automáticamente.' };
    }

    const memoria = {
      modelo,
      ejercicio,
      nota: 'STUB de memoria. Componer según el modelo oficial (normal/abreviado/pyme).',
      apartados: ['Actividad de la empresa', 'Bases de presentación', 'Normas de registro y valoración', 'Inmovilizado', 'Situación fiscal'],
    };

    const dataJson = { modelo, ejercicio, estados, memoria };

    const pdf = await generarPdfA(`Memoria - Ejercicio ${ejercicio}`, [
      `Empresa (companyId): ${fy.companyId}`,
      `Modelo: ${modelo}`,
      `Ejercicio: ${ejercicio}`,
      '',
      'Apartados de la memoria:',
      ...memoria.apartados.map((a) => ` - ${a}`),
      '',
      'NOTA: contenido de la memoria pendiente de integración (stub).',
    ]);
    const hash = sha256(pdf);
    const filePath = await guardarArtefacto(fy.companyId, fyId, `cuentas-anuales-${ejercicio}.pdf`, pdf);

    const cuenta = await prisma.annualAccounts.create({
      data: {
        companyId: fy.companyId,
        fiscalYearId: fyId,
        modelo,
        filePath,
        dataJson: dataJson as unknown as Prisma.InputJsonValue,
        hash,
        status: 'READY',
      },
    });

    return { accountId: cuenta.id, format: cuenta.format, filePath: cuenta.filePath, hash: cuenta.hash, status: cuenta.status };
  },

  async listar(fyId: string) {
    return prisma.annualAccounts.findMany({ where: { fiscalYearId: fyId }, orderBy: { createdAt: 'desc' } });
  },

  async obtener(id: string) {
    const c = await prisma.annualAccounts.findUnique({ where: { id } });
    if (!c) throw notFound('Cuentas anuales no encontradas.');
    return c;
  },

  /** Registra la presentación en el Registro (status READY -> FILED). */
  async registrarPresentacion(id: string, datos: { filedAt?: string; registryEntryNumber?: string; csv?: string }) {
    const c = await this.obtener(id);
    if (!puedeTransicionarCuentas(c.status as EstadoCuentas, 'FILED')) {
      throw badRequest(`No se puede presentar desde el estado ${c.status} (debe estar READY o tras DEFECTOS).`);
    }
    return prisma.annualAccounts.update({
      where: { id },
      data: {
        status: 'FILED',
        filedAt: datos.filedAt ?? new Date().toISOString(),
        registryEntryNumber: datos.registryEntryNumber,
        csv: datos.csv,
      },
    });
  },

  /** Guarda la resolución del registrador (FILED -> APROBADO | DEFECTOS | RECHAZADO). */
  async registrarResolucion(id: string, status: string) {
    const c = await this.obtener(id);
    if (!RESOLUCIONES_CUENTAS.includes(status as EstadoCuentas)) {
      throw badRequest(`status debe ser uno de: ${RESOLUCIONES_CUENTAS.join(', ')}.`);
    }
    if (!puedeTransicionarCuentas(c.status as EstadoCuentas, status as EstadoCuentas)) {
      throw badRequest(`Transición no válida: ${c.status} -> ${status} (las cuentas deben estar FILED).`);
    }
    return prisma.annualAccounts.update({ where: { id }, data: { status } });
  },
};
