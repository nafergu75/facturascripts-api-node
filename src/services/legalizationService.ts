import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { crearZip, sha256, ZipEntry } from '../utils/zip';
import { guardarArtefacto, leerArtefacto } from './registroMercantil.helpers';
import { fiscalYearsService } from './fiscalYears.service';
import { EstadoPaquete, puedeTransicionarPaquete } from '../domain/registroMercantil.model';

export interface PresentacionInput {
  status?: string; // se espera 'FILED'
  filedAt?: string;
  registryOffice?: string;
  registryEntryNumber?: string;
  csvJustificante?: string;
}

export const legalizationService = {
  /**
   * Empaqueta los libros seleccionados (o todos los GENERATED del ejercicio) en
   * un ZIP, calcula su SHA-256 y crea el expediente (status CREATED). Los libros
   * incluidos pasan a PACKAGE_READY. La API NO firma el ZIP (eso lo hace el
   * usuario con su certificado en sede.registradores.org).
   */
  async crearPaquete(fyId: string, bookIds?: string[]) {
    const fy = await fiscalYearsService.obtener(fyId);

    const where = bookIds && bookIds.length
      ? { id: { in: bookIds }, fiscalYearId: fyId }
      : { fiscalYearId: fyId, status: { in: ['GENERATED', 'PACKAGE_READY'] } };
    const libros = await prisma.legalBook.findMany({ where });

    const conPdf = libros.filter((l) => l.filePath);
    if (conPdf.length === 0) throw badRequest('No hay libros generados (con PDF) para empaquetar.');

    const entries: ZipEntry[] = [];
    for (const l of conPdf) {
      entries.push({ name: `libro-${l.type}.pdf`, data: await leerArtefacto(l.filePath) });
    }

    const zip = crearZip(entries);
    const hash = sha256(zip);
    const zipPath = await guardarArtefacto(fy.companyId, fyId, `expediente-legalizacion-${Date.now()}.zip`, zip);

    const paquete = await prisma.legalizationPackage.create({
      data: { companyId: fy.companyId, fiscalYearId: fyId, zipPath, hash, size: zip.length, status: 'CREATED' },
    });

    await prisma.legalBook.updateMany({ where: { id: { in: conPdf.map((l) => l.id) } }, data: { status: 'PACKAGE_READY' } });

    return { packageId: paquete.id, hash: paquete.hash, size: paquete.size, createdAt: paquete.createdAt, status: paquete.status };
  },

  async obtener(packageId: string) {
    const p = await prisma.legalizationPackage.findUnique({ where: { id: packageId } });
    if (!p) throw notFound('Expediente de legalización no encontrado.');
    return p;
  },

  /** PATCH: registra la presentación manual (status -> FILED) y sus datos de registro. */
  async actualizarPresentacion(packageId: string, datos: PresentacionInput) {
    const p = await this.obtener(packageId);
    const nuevoEstado = (datos.status as EstadoPaquete) ?? 'FILED';
    if (!puedeTransicionarPaquete(p.status as EstadoPaquete, nuevoEstado)) {
      throw badRequest(`Transición de estado no válida: ${p.status} -> ${nuevoEstado}.`);
    }
    return prisma.legalizationPackage.update({
      where: { id: packageId },
      data: {
        status: nuevoEstado,
        filedAt: datos.filedAt ?? new Date().toISOString(),
        registryOffice: datos.registryOffice,
        registryEntryNumber: datos.registryEntryNumber,
        csv: datos.csvJustificante,
      },
    });
  },

  /** Sube el PDF de la diligencia emitida por el Registro y marca el expediente ACCEPTED. */
  async guardarDiligencia(packageId: string, pdf: Buffer) {
    const p = await this.obtener(packageId);
    if (!puedeTransicionarPaquete(p.status as EstadoPaquete, 'ACCEPTED')) {
      throw badRequest(`No se puede aceptar el expediente desde el estado ${p.status} (debe estar FILED).`);
    }
    const diligencePath = await guardarArtefacto(p.companyId, p.fiscalYearId, `diligencia-${packageId}.pdf`, pdf);
    return prisma.legalizationPackage.update({
      where: { id: packageId },
      data: { diligencePath, status: 'ACCEPTED' },
    });
  },
};
