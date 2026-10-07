import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { inverso, textoTipo, validarMoneda } from '../domain/divisas';
import { perfilEmpresa } from '../services/perfilEmpresa.service';
import { resolverTipoCambio } from '../services/tiposCambio.service';
import { hoyEspana } from '../utils/fechas';

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

export const tiposCambioController = {
  /**
   * GET /companies/:companyId/tipos-cambio?moneda=USD&fecha=AAAA-MM-DD
   * Tipo de referencia del BCE para una factura en `moneda` con devengo en
   * `fecha` (hoy si no se indica): unidades de `moneda` por 1 de la moneda de
   * cuenta. Si el BCE no responde, tipoCambio null y un aviso para indicarlo a
   * mano (el formulario lo pide). Al BCE solo se envian la moneda y la fecha.
   */
  obtener: asyncHandler(async (req, res) => {
    const perfil = await perfilEmpresa(req.companyId!);
    const moneda = validarMoneda(req.query.moneda ?? '', perfil.monedasFactura);
    const fecha = String(req.query.fecha ?? hoyEspana()).slice(0, 10);
    if (!FECHA_RE.test(fecha) || Number.isNaN(new Date(`${fecha}T00:00:00Z`).getTime())) {
      throw badRequest('La fecha no es válida (AAAA-MM-DD).');
    }
    const t = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda, devengo: fecha, definitivo: false });
    const hay = t.tipoCambio !== null;
    sendOk(res, {
      monedaCuenta: perfil.monedaCuenta,
      moneda,
      fecha,
      tipoCambio: t.tipoCambio,
      fechaTipoCambio: t.fechaTipoCambio,
      fuente: t.fuente,
      texto: hay ? textoTipo(perfil.monedaCuenta, moneda, t.tipoCambio as number) : null,
      inverso: hay ? inverso(t.tipoCambio as number) : null,
      textoInverso: hay && t.tipoCambio !== 1 ? textoTipo(moneda, perfil.monedaCuenta, inverso(t.tipoCambio as number)) : null,
      provisional: t.provisional,
      ...(t.aviso ? { aviso: t.aviso } : {}),
    });
  }),
};
