import { asyncHandler } from '../utils/async-handler';
import { sendMessage, sendOk } from '../utils/response';
import { registrarAuditoria } from '../services/auditoria.service';
import { guardarAjustesFacturacion, obtenerAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { guardarAjustesFiscales, obtenerAjustesFiscales, previsualizarAjustesFiscales } from '../services/ajustesFiscales.service';
import { borrarImagenFactura, guardarImagenFactura, leerTipoImagenFactura, obtenerImagenFactura } from '../services/imagenesFactura.service';

/** Configuración: valores por defecto de facturación y ajustes fiscales. */
export const ajustesController = {
  /** GET /imagenes/:tipo — el logo de la marca o el sello de la plantilla B (404 si no hay). */
  obtenerImagen: asyncHandler(async (req, res) => {
    const tipo = leerTipoImagenFactura(req.params.tipo);
    const imagen = await obtenerImagenFactura(req.companyId!, tipo);
    if (!imagen) {
      res.status(404).json({ message: tipo === 'MARCA' ? 'No hay logo de la marca.' : 'No hay sello.' });
      return;
    }
    res.setHeader('Content-Type', imagen.mime);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(imagen.bytes);
  }),

  /** PUT /imagenes/:tipo — sube o cambia la imagen (campo de formulario "imagen"). */
  guardarImagen: asyncHandler(async (req, res) => {
    const tipo = leerTipoImagenFactura(req.params.tipo);
    await guardarImagenFactura(req.companyId!, tipo, req.file?.buffer);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_IMAGEN_FACTURA',
      resourceType: 'AJUSTES_FACTURACION',
      resourceId: req.companyId,
      meta: { tipo },
    });
    sendMessage(res, tipo === 'MARCA' ? 'Logo de la marca guardado.' : 'Sello guardado.');
  }),

  /** DELETE /imagenes/:tipo — quita la imagen. */
  borrarImagen: asyncHandler(async (req, res) => {
    const tipo = leerTipoImagenFactura(req.params.tipo);
    await borrarImagenFactura(req.companyId!, tipo);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'DELETE_IMAGEN_FACTURA',
      resourceType: 'AJUSTES_FACTURACION',
      resourceId: req.companyId,
      meta: { tipo },
    });
    sendMessage(res, tipo === 'MARCA' ? 'Logo de la marca quitado.' : 'Sello quitado.');
  }),

  leerFacturacion: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerAjustesFacturacion(req.companyId!));
  }),

  guardarFacturacion: asyncHandler(async (req, res) => {
    const ajustes = await guardarAjustesFacturacion(req.companyId!, req.user!.userId, req.body);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_AJUSTES_FACTURACION',
      resourceType: 'AJUSTES_FACTURACION',
      resourceId: req.companyId,
      meta: { campos: Object.keys(req.body ?? {}) },
    });
    sendOk(res, ajustes);
  }),

  leerFiscales: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerAjustesFiscales(req.companyId!));
  }),

  guardarFiscales: asyncHandler(async (req, res) => {
    const r = await guardarAjustesFiscales(req.companyId!, req.user!.userId, req.body);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_AJUSTES_FISCALES',
      resourceType: 'AJUSTES_FISCALES',
      resourceId: req.companyId,
      meta: { periodicidadIva: r.periodicidadIva, redeme: r.redeme, sii: r.sii, granEmpresa: r.granEmpresa, cambiosCalendario: r.cambiosCalendario },
    });
    sendOk(res, r);
  }),

  vistaPreviaFiscales: asyncHandler(async (req, res) => {
    sendOk(res, await previsualizarAjustesFiscales(req.companyId!, req.body));
  }),
};
