import { prisma } from '../config/database';
import { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../utils/http-errors';
import { generarPdfA } from '../utils/pdf-a';
import { sha256 } from '../utils/zip';
import { guardarArtefacto } from './registroMercantil.helpers';
import { fiscalYearsService } from './fiscalYears.service';
import { generarCuentasAnuales } from './cuentasAnuales.service';
import { filasCuentasAnuales } from './cuentasAnualesPdf';
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
    if (!['PYME', 'ABREVIADO', 'NORMAL'].includes(modelo)) throw badRequest('modelo debe ser PYME, ABREVIADO o NORMAL.');
    const fy = await fiscalYearsService.obtener(fyId);
    const ejercicio = ejercicioDe(fy);

    // Si no se pueden calcular los estados, se para aqui: antes se generaba igual
    // un PDF sin cifras, que se podia presentar por error.
    const estados = await generarCuentasAnuales(fy.companyId, ejercicio);

    // MEMORIA: pendiente (punto 3). Solo los apartados.
    const memoria = {
      modelo,
      ejercicio,
      nota: 'Memoria pendiente: solo se listan los apartados.',
      apartados: ['Actividad de la empresa', 'Bases de presentación', 'Normas de registro y valoración', 'Inmovilizado', 'Situación fiscal'],
    };

    const dataJson = { modelo, ejercicio, estados, memoria };

    const pdf = await generarPdfA(`Cuentas anuales ${ejercicio} - ${estados.sociedad.denominacion || 'Empresa'}`, [
      ...filasCuentasAnuales(estados, modelo),
      { texto: 'MEMORIA', nuevaPagina: true },
      { texto: '' },
      ...memoria.apartados.map((a) => ({ texto: `- ${a}` })),
      { texto: '' },
      { texto: 'Pendiente de redactar: la memoria todavía no se genera con contenido.' },
    ]);
    const hash = sha256(pdf);

    // Cada generacion es una version nueva con su propio fichero: antes todas se
    // guardaban como cuentas-anuales-<ejercicio>.pdf y regenerar sobrescribia el
    // PDF de las versiones anteriores (incluso de una ya presentada).
    const anterior = await prisma.annualAccounts.findFirst({ where: { fiscalYearId: fyId }, orderBy: { version: 'desc' } });
    const version = (anterior?.version ?? 0) + 1;
    const filePath = await guardarArtefacto(fy.companyId, fyId, `cuentas-anuales-${ejercicio}-v${version}.pdf`, pdf);
    await prisma.annualAccounts.updateMany({ where: { fiscalYearId: fyId, isLatestVersion: true }, data: { isLatestVersion: false } });

    const cuenta = await prisma.annualAccounts.create({
      data: {
        companyId: fy.companyId,
        fiscalYearId: fyId,
        version,
        isLatestVersion: true,
        modelo,
        filePath,
        dataJson: dataJson as unknown as Prisma.InputJsonValue,
        hash,
        status: 'READY',
      },
    });

    return { accountId: cuenta.id, version: cuenta.version, format: cuenta.format, filePath: cuenta.filePath, hash: cuenta.hash, status: cuenta.status };
  },

  async listar(fyId: string) {
    return prisma.annualAccounts.findMany({ where: { fiscalYearId: fyId }, orderBy: { version: 'desc' } });
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
