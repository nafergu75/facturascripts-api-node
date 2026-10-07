/**
 * Validacion del cuerpo de una factura de gasto: cada error es un 400 con el
 * mensaje en castellano y el campo que hay que marcar en la pantalla.
 */
import { describe, it, expect } from '@jest/globals';
import { validarFacturaGasto } from '../schemas/factura-gasto.schemas';
import { HttpError } from '../utils/http-errors';

const valida = () => ({
  proveedor: { id: 'sup_1' },
  numeroFacturaProveedor: 'F2026/0012',
  fechaEmision: '2026-04-03',
  tipoGasto: 'SERVICIO_PROFESIONAL',
  lineas: [{ descripcion: 'Asesoría abril', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }],
});

function error(cuerpo: unknown, opciones?: Parameters<typeof validarFacturaGasto>[1]): { status: number; message: string; campo?: string } {
  try {
    validarFacturaGasto(cuerpo, opciones);
  } catch (e) {
    const h = e as HttpError;
    return { status: h.statusCode, message: h.message, campo: (h.details as { campo?: string } | undefined)?.campo };
  }
  throw new Error('No dio error');
}

describe('validarFacturaGasto', () => {
  it('una factura correcta pasa, con los valores por defecto', () => {
    const d = validarFacturaGasto(valida());
    expect(d.lineas[0]).toMatchObject({ descuentoPorcentaje: 0, tipoRetencion: 15 });
    expect(d.numeroFacturaProveedor).toBe('F2026/0012');
  });

  it('acepta el alias antiguo provider', () => {
    const { proveedor, ...resto } = valida();
    expect(validarFacturaGasto({ ...resto, provider: proveedor }).proveedor).toEqual({ id: 'sup_1' });
  });

  it('sin el numero del proveedor', () => {
    const { numeroFacturaProveedor: _n, ...sin } = valida();
    expect(error(sin)).toEqual({ status: 400, message: 'Escribe el número que puso el proveedor en su factura.', campo: 'numeroFacturaProveedor' });
    expect(error({ ...valida(), numeroFacturaProveedor: '   ' }).campo).toBe('numeroFacturaProveedor');
  });

  it('IVA del 7 %', () => {
    const c = valida();
    c.lineas[0].tipoIva = 7;
    expect(error(c)).toEqual({ status: 400, message: 'El IVA tiene que ser 0, 4, 5, 10 o 21 %.', campo: 'lineas.0.tipoIva' });
  });

  it('retencion en una compra de mercaderias', () => {
    expect(error({ ...valida(), tipoGasto: 'COMPRA' })).toMatchObject({ status: 400, campo: 'lineas.0.tipoRetencion' });
    expect(error({ ...valida(), tipoGasto: 'COMPRA' }).message).toMatch(/Solo las facturas de profesionales/);
  });

  it('alquiler al 15 %', () => {
    expect(error({ ...valida(), tipoGasto: 'ALQUILER' })).toMatchObject({ status: 400, campo: 'lineas.0.tipoRetencion' });
    const ok = valida();
    ok.lineas[0].tipoRetencion = 19;
    expect(() => validarFacturaGasto({ ...ok, tipoGasto: 'ALQUILER' })).not.toThrow();
  });

  it('proveedor de fuera de España con IVA', () => {
    const c = valida();
    c.lineas[0].tipoRetencion = 0;
    const e = error(c, { paisProveedor: 'FR' });
    expect(e).toMatchObject({ status: 400, campo: 'lineas.0.tipoIva' });
    expect(e.message).toMatch(/fuera de España no te cobra IVA español/);
    c.lineas[0].tipoIva = 0;
    expect(() => validarFacturaGasto(c, { paisProveedor: 'FR' })).not.toThrow();
  });

  it('fecha de registro anterior a la de la factura', () => {
    expect(error({ ...valida(), fechaRegistro: '2026-04-02' })).toEqual({
      status: 400,
      message: 'La fecha de registro no puede ser anterior a la fecha de la factura.',
      campo: 'fechaRegistro',
    });
  });

  it('fecha que no existe y vencimiento anterior', () => {
    expect(error({ ...valida(), fechaEmision: '2026-02-30' })).toMatchObject({ message: 'Esa fecha no existe.', campo: 'fechaEmision' });
    expect(error({ ...valida(), fechaVencimiento: '2026-01-01' }).campo).toBe('fechaVencimiento');
  });

  it('total de la factura que no cuadra', () => {
    const e = error({ ...valida(), totalDocumento: 1100 });
    expect(e).toMatchObject({ status: 400, campo: 'totalDocumento' });
    expect(e.message).toMatch(/^El total calculado \(1\.060,00 €\) no coincide con el de la factura \(1\.100,00 €\)/);
    expect(() => validarFacturaGasto({ ...valida(), totalDocumento: 1060.02 })).not.toThrow();
  });

  it('importe cero y tipo de gasto desconocido', () => {
    const c = valida();
    c.lineas[0].precioUnitario = 0;
    expect(error(c).message).toMatch(/El importe tiene que ser mayor que cero/);
    expect(error({ ...valida(), tipoGasto: 'OTRO' }).campo).toBe('tipoGasto');
  });

  it('sin proveedor, o con los dos a la vez', () => {
    const { proveedor: _p, ...sin } = valida();
    expect(error(sin)).toMatchObject({ message: 'Elige el proveedor de la factura.', campo: 'proveedor' });
    expect(error({ ...valida(), proveedor: { id: 'a', nuevo: {} } }).campo).toBe('proveedor');
  });
});
