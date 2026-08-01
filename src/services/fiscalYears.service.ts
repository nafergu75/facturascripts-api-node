import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { calcularPlazos, TipoLibro } from '../domain/registroMercantil.model';
import { legalConfigService } from './legalConfig.service';

export const fiscalYearsService = {
  async listar(companyId: string) {
    return prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { label: 'desc' } });
  },

  /** Carga un ejercicio por id y valida que pertenece a la empresa esperada (si se pasa). */
  async obtener(fyId: string) {
    const fy = await prisma.fiscalYear.findUnique({ where: { id: fyId } });
    if (!fy) throw notFound('Ejercicio contable no encontrado.');
    return fy;
  },

  async crear(companyId: string, datos: { label: string; fechaInicio: string; fechaFin: string }) {
    if (!datos.label || !datos.fechaInicio || !datos.fechaFin) {
      throw badRequest('label, fechaInicio y fechaFin son obligatorios.');
    }
    const duplicado = await prisma.fiscalYear.findFirst({ where: { companyId, label: datos.label } });
    if (duplicado) throw badRequest(`Ya existe un ejercicio con label "${datos.label}".`);
    return prisma.fiscalYear.create({
      data: {
        companyId,
        label: datos.label,
        fechaInicio: datos.fechaInicio,
        fechaFin: datos.fechaFin,
        estado: 'OPEN',
      },
    });
  },

  /**
   * Cierra el ejercicio:
   *  - Valida que no esté ya cerrado y que tenga fecha de cierre (closingDate o fechaFin).
   *  - Bloquea nuevos asientos (asientosBloqueados = true).
   *  - Calcula plazos: legalización = cierre + 4 meses, depósito = cierre + 7 meses.
   *  - Dispara borradores de libros (filas PENDING) según las obligaciones de la empresa.
   */
  async cerrar(fyId: string, closingDateInput?: string) {
    const fy = await this.obtener(fyId);
    if (fy.estado === 'CLOSED') throw badRequest('El ejercicio ya está cerrado.');

    const closingDate = closingDateInput || fy.fechaFin;
    if (!closingDate) throw badRequest('No hay fecha de cierre (closingDate) ni fechaFin del ejercicio.');

    const plazos = calcularPlazos(closingDate);

    const cerrado = await prisma.fiscalYear.update({
      where: { id: fyId },
      data: {
        estado: 'CLOSED',
        closingDate: plazos.closingDate,
        legalizationDeadline: plazos.legalizationDeadline,
        accountsDepositDeadline: plazos.accountsDepositDeadline,
        asientosBloqueados: true,
      },
    });

    // Borradores de libros obligatorios (PENDING) según la config legal.
    const cfg = await legalConfigService.obtener(fy.companyId);
    const obligatorios: TipoLibro[] = ['DIARIO', 'INVENTARIOS_CUENTAS_ANUALES', 'ACTAS'];
    if (cfg.obligaLibroSocios) obligatorios.push('SOCIOS');
    if (cfg.obligaLibroContratos) obligatorios.push('CONTRATOS');

    for (const type of obligatorios) {
      const yaExiste = await prisma.legalBook.findFirst({ where: { fiscalYearId: fyId, type } });
      if (!yaExiste) {
        await prisma.legalBook.create({
          data: { companyId: fy.companyId, fiscalYearId: fyId, type, filePath: '', hash: '', status: 'PENDING' },
        });
      }
    }

    return cerrado;
  },
};
