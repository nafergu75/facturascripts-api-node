/**
 * Controlador del EXTRACTOR DE GASTOS con IA.
 * Rutas: /companies/:companyId/gastos-extractor/* (ver gastos-extractor.routes.ts)
 *
 * Acepta DOS formatos para máxima flexibilidad:
 *  - multipart/form-data con campo 'archivo'
 *  - JSON: { archivoBase64, nombre, mimeType }
 */

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/http-errors';
import { prisma } from '../config/database';
import { AVISO_NO_FACTURA, gastosExtractorService, GastoExtraido, GastoExtraidoEmpresa } from '../services/gastos-extractor.service';
import { cuentaHabitualDeProveedor } from '../services/cuentasLinea.service';
import { empresaConNominas, expenseInvoicesService } from '../services/expense-invoices.service';
import { normalizarNumeroProveedor } from '../domain/factura-gasto.model';
import { limpiarNif } from '../domain/tipo-operacion.model';
import { normalizarNif } from '../utils/nif';
import { registrarAuditoria } from '../services/auditoria.service';
import { errorFalloBD, QUE_HACER_REGISTRAR } from '../utils/errores-bd';
import { comprobarLecturaParaConfirmar, esLecturaRectificativa, prefijoObservaciones, vincularLectura } from '../services/lectura/confirmar';
import { exigirProveedorDadoDeAlta } from '../services/lectura/terceros-lector';

/** Tamano maximo del archivo: el cuerpo de una funcion de Vercel no pasa de 4,5 MB. */
export const MAX_ARCHIVO_LECTOR = 4 * 1024 * 1024;
export const MENSAJE_ARCHIVO_GRANDE = 'El archivo pesa más de 4 MB: redúcelo o hazle una foto con menos resolución.';

interface ArchivoSubido {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Normaliza la subida (multipart multer o JSON base64) a un archivo en memoria.
 */
function extraerArchivo(req: Request): { archivo: ArchivoSubido } {
  const file = (req as Request & { file?: ArchivoSubido }).file;
  if (file?.buffer?.length) {
    return {
      archivo: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
      },
    };
  }

  const { archivoBase64, nombre, mimeType } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof archivoBase64 === 'string' && archivoBase64.length > 0) {
    const buffer = Buffer.from(archivoBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length === 0) throw badRequest('archivoBase64 no contiene datos válidos.');
    if (buffer.length > MAX_ARCHIVO_LECTOR) throw badRequest(MENSAJE_ARCHIVO_GRANDE);
    return {
      archivo: {
        buffer,
        originalname: typeof nombre === 'string' && nombre ? nombre : 'comprobante.pdf',
        mimetype: typeof mimeType === 'string' && mimeType ? mimeType : 'application/pdf',
      },
    };
  }

  throw badRequest("No se recibió archivo: usa multipart (campo 'archivo') o JSON { archivoBase64, nombre, mimeType }.");
}

export const gastosExtractorController = {
  /**
   * POST /extraer-ia — extraer datos contables de un comprobante de gasto (síncrono).
   * Retorna GastoExtraido con sugerencia de cuenta contable, y el proveedor de
   * la empresa con ese NIF (si lo hay) y la factura ya registrada con ese
   * numero (si la hay).
   */
  extraer: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const { archivo } = extraerArchivo(req);
    const resultado: GastoExtraido = await gastosExtractorService.extraer(archivo);

    let proveedorExistente: GastoExtraidoEmpresa['proveedorExistente'] = null;
    let duplicada: GastoExtraidoEmpresa['duplicada'] = null;
    if (resultado.nifProveedor) {
      const nifs = [...new Set([normalizarNif(resultado.nifProveedor), limpiarNif(resultado.nifProveedor)].filter(Boolean))];
      proveedorExistente = await prisma.supplier.findFirst({
        where: { companyId, nifCif: { in: nifs } },
        select: { id: true, nombreFiscal: true, nifCif: true },
      });
    }
    if (proveedorExistente && resultado.numeroFactura) {
      const f = await prisma.expenseInvoice.findFirst({
        where: { companyId, supplierId: proveedorExistente.id, numeroProveedorActivo: normalizarNumeroProveedor(resultado.numeroFactura) },
        select: { id: true, numeroCompleto: true },
      });
      duplicada = f ? { facturaId: f.id, numeroCompleto: f.numeroCompleto } : null;
    }
    const cuentaHabitual = proveedorExistente ? await cuentaHabitualDeProveedor(companyId, proveedorExistente.id) : null;
    const data: GastoExtraidoEmpresa = { ...resultado, proveedorExistente, duplicada, cuentaHabitual };
    res.status(201).json({ ok: true, data });
  }),

  /**
   * POST /confirmar — registra la factura revisada en la pantalla. El cuerpo
   * es el del alta (FacturaGastoSchema) mas tipoDocumento y confianza. La
   * factura y su asiento quedan en borrador («Pendiente de revisar») hasta que
   * se apruebe el asiento en el Motor contable. Las nominas y los seguros
   * sociales de una empresa con trabajadores siguen dando 400 (van a Nominas).
   * El proveedor llega como { id }: uno nuevo da 400 TERCERO_NO_DADO_DE_ALTA.
   */
  confirmar: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const { tipoDocumento, confianza } = cuerpo;
    // La cuenta: la del formulario (cuentaGasto) o la de antes (cuentaContableBase).
    const cuenta = typeof cuerpo.cuentaGasto === 'string' ? cuerpo.cuentaGasto : typeof cuerpo.cuentaContableBase === 'string' ? cuerpo.cuentaContableBase : null;

    // Las nominas y los seguros sociales de una empresa que lleva sus nominas en la
    // app no son facturas de gasto: van a Nominas (antes se guardaban como facturas
    // de la 640/642, sin trabajador ni retenciones). Si el usuario corrige la
    // clasificacion en la pantalla ("Es una factura de gasto"), llega como 'factura'
    // y, si alguna linea va a la 640-642, lo frena registrarGasto.
    if ((tipoDocumento === 'nomina' || tipoDocumento === 'seguros_sociales') && (await empresaConNominas(companyId))) {
      throw badRequest(AVISO_NO_FACTURA[tipoDocumento]);
    }

    // Lectura con Azure (POST /lecturas): llega por el extra del formulario. Sin ella, como siempre.
    // Primero lo de la lectura (que exista y siga sin registrar); despues, el proveedor; y por ultimo,
    // en un abono leido, que rectifica: la factura original solo se puede elegir entre las del proveedor.
    const lectura =
      typeof cuerpo.lecturaId === 'string' && cuerpo.lecturaId
        ? await comprobarLecturaParaConfirmar(companyId, cuerpo.lecturaId, 'GASTO', cuerpo).catch(async (e: unknown) => {
            if ((e as { details?: { codigo?: unknown } })?.details?.codigo === 'FALTA_RECTIFICATIVA') await exigirProveedorDadoDeAlta(companyId, cuerpo);
            throw e;
          })
        : null;
    // El proveedor tiene que estar dado de alta (llega su id): el lector ya no lo crea solo.
    await exigirProveedorDadoDeAlta(companyId, cuerpo);

    const pct = typeof confianza === 'number' && Number.isFinite(confianza) ? Math.round(confianza <= 1 ? confianza * 100 : confianza) : null;
    const prefijo = lectura
      ? prefijoObservaciones(lectura.origen, lectura.confianza)
      : pct !== null
        ? `Leída con el lector de gastos (confianza ${pct} %).`
        : 'Leída con el lector de gastos.';
    const { cuentaContableBase: _antigua, lecturaId: _lectura, revisado: _revisado, noEsRectificativa: _noEs, ...resto } = cuerpo;
    // Factura y asiento van en la misma transaccion: si la base de datos falla,
    // no queda nada registrado y se dice asi, en castellano (no el texto de Prisma).
    const r = await expenseInvoicesService
      .registrarGasto(
        companyId,
        { ...resto, ...(cuerpo.cuentaGasto === undefined && cuenta ? { cuentaGasto: cuenta } : {}) },
        { contabilizar: 'DRAFT', prefijoObservaciones: prefijo, usuarioEmail: req.user?.email, userId: req.user?.userId },
      )
      .catch((e: unknown) => {
        throw errorFalloBD(e, QUE_HACER_REGISTRAR, 'registrar la factura de gasto leída') ?? e;
      });
    if (lectura) await vincularLectura(companyId, { lecturaId: lectura.id }, { expenseInvoiceId: r.factura.id, userId: req.user?.userId, revisada: cuerpo.revisado === true });
    // El lector la leyo como rectificativa o abono y quien registra dice que no lo es: queda constancia.
    if (lectura && esLecturaRectificativa(lectura) && cuerpo.noEsRectificativa === true && cuerpo.rectificativa == null) {
      await registrarAuditoria({
        userId: req.user?.userId ?? 'SYSTEM',
        companyId,
        action: 'LECTOR_NO_ES_RECTIFICATIVA',
        resourceType: 'ExpenseInvoice',
        resourceId: r.factura.id,
        meta: { lecturaId: lectura.id },
      });
    }
    res.status(201).json({ ok: true, data: { factura: r.factura, asientoId: r.asientoId, asientoEstado: 'DRAFT', proveedorCreado: r.proveedorCreado } });
  }),
};
