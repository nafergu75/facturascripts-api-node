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

  it('profesionales al 1 % o al 2 %: no son de la clave G del 190', () => {
    for (const pct of [1, 2]) {
      const c = valida();
      c.lineas[0].tipoRetencion = pct;
      expect(error(c)).toEqual({
        status: 400,
        message: 'Las retenciones del 1 % y del 2 % (actividades agrícolas, ganaderas y forestales o en módulos) aún no están disponibles: consúltalo con tu asesor.',
        campo: 'lineas.0.tipoRetencion',
      });
    }
    const siete = valida();
    siete.lineas[0].tipoRetencion = 7;
    expect(() => validarFacturaGasto(siete)).not.toThrow();
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

describe('abonos y rectificativas de proveedor (bloque rectificativa)', () => {
  const abono = (rect: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    proveedor: { id: 'sup_1' },
    numeroFacturaProveedor: 'R-2027/004',
    fechaEmision: '2027-02-10',
    fechaRegistro: '2027-02-12',
    tipoGasto: 'COMPRA',
    lineas: [{ descripcion: 'Devolución 3 cajas', cantidad: 3, precioUnitario: -40, tipoIva: 21, cuenta: '608' }],
    totalDocumento: -145.2,
    rectificativa: { tipo: 'I', causa: 'DEVOLUCION', motivo: 'Mercancía dañada', originales: [{ id: 'ckx1' }], ...rect },
    ...extra,
  });

  it('un abono por diferencias con su original pasa, con los importes en negativo', () => {
    const d = validarFacturaGasto(abono());
    expect(d.rectificativa).toMatchObject({ tipo: 'I', causa: 'DEVOLUCION', originales: [{ id: 'ckx1' }] });
    expect(d.lineas[0].precioUnitario).toBe(-40);
  });

  it('sin el bloque, una factura normal sigue sin admitir precios negativos ni base cero, y explica cómo registrar un abono', () => {
    const c = valida();
    c.lineas[0].precioUnitario = -10;
    expect(error(c)).toMatchObject({ status: 400, message: 'El precio no puede ser negativo. Si es un abono o una rectificativa del proveedor, regístrala como abono: Compras › Nueva factura de gasto › Abono o rectificativa.', campo: 'lineas.0.precioUnitario' });
    c.lineas[0].precioUnitario = 0;
    expect(error(c).message).toBe(
      'El importe tiene que ser mayor que cero. Si es un abono o una rectificativa del proveedor, regístrala como abono: Compras › Nueva factura de gasto › Abono o rectificativa.',
    );
  });

  it('causa: de la lista; impago y concurso no se admiten', () => {
    expect(error(abono({ causa: 'OTRA' }))).toMatchObject({ status: 400, campo: 'rectificativa.causa' });
    expect(error(abono({ causa: 'IMPAGO' })).message).toMatch(/^Las rectificativas por impago o concurso no se registran como un abono/);
    expect(error(abono({ causa: 'CONCURSO' })).campo).toBe('rectificativa.causa');
  });

  it('tipo I o S', () => {
    expect(error(abono({ tipo: 'X' }))).toMatchObject({ status: 400, message: 'Elige si la rectificativa es por diferencias o por sustitución.', campo: 'rectificativa.tipo' });
  });

  it('hace falta una original o un periodo, y el periodo solo en rappels y descuentos', () => {
    expect(error(abono({ originales: [] }))).toMatchObject({
      message: 'Indica qué factura rectifica, o el periodo si es un descuento por volumen.',
      campo: 'rectificativa.originales',
    });
    expect(error(abono({ originales: [], periodo: { desde: '2027-01-01', hasta: '2027-03-31' } })).campo).toBe('rectificativa.periodo');
    const rappel = abono({ causa: 'RAPPEL', originales: [], periodo: { desde: '2027-01-01', hasta: '2027-03-31' } });
    expect(() => validarFacturaGasto(rappel)).not.toThrow();
    expect(error(abono({ causa: 'RAPPEL', originales: [], periodo: { desde: '2027-03-31', hasta: '2027-01-01' } })).campo).toBe('rectificativa.periodo.hasta');
  });

  it('rappel de varios periodos: el reparto por periodo va dentro del periodo y suma la base', () => {
    const periodo = (reparto: unknown[]) => ({ causa: 'RAPPEL', originales: [], periodo: { desde: '2027-01-01', hasta: '2027-06-30', reparto } });
    const bien = [
      { desde: '2027-01-01', hasta: '2027-03-31', base: -20 },
      { desde: '2027-04-01', hasta: '2027-06-30', base: -100 },
    ];
    expect(validarFacturaGasto(abono(periodo(bien))).rectificativa?.periodo?.reparto).toHaveLength(2);
    expect(error(abono(periodo([bien[0], { ...bien[1], base: -90 }])))).toMatchObject({
      message: 'El reparto por periodos (-110,00 €) no suma la base de la rectificativa (-120,00 €).',
      campo: 'rectificativa.periodo.reparto',
    });
    expect(error(abono(periodo([bien[0], { ...bien[1], hasta: '2027-07-31' }])))).toMatchObject({
      message: 'Cada tramo del reparto tiene que estar dentro del periodo del rappel.',
      campo: 'rectificativa.periodo.reparto.1',
    });
    expect(error(abono(periodo([bien[0], { ...bien[1], desde: '2027-03-01' }])))).toMatchObject({
      message: 'Los tramos del reparto no pueden solaparse.',
      campo: 'rectificativa.periodo.reparto.1',
    });
  });

  it('cada original de fuera lleva número y fecha, y no puede ser posterior a la rectificativa', () => {
    expect(error(abono({ originales: [{ numero: 'F-2026/118' }] }))).toMatchObject({ campo: 'rectificativa.originales.0.fecha' });
    expect(error(abono({ originales: [{ fecha: '2026-11-30' }] }))).toMatchObject({ campo: 'rectificativa.originales.0.numero' });
    expect(error(abono({ originales: [{ numero: 'F-2026/118', fecha: '2027-03-01' }] }))).toMatchObject({
      message: 'La rectificativa no puede tener fecha anterior a la de la factura que rectifica (01/03/2027).',
      campo: 'fechaEmision',
    });
    expect(() => validarFacturaGasto(abono({ originales: [{ numero: 'F-2026/118', fecha: '2026-11-30' }] }))).not.toThrow();
  });

  it('una rectificativa que no cambia ningún importe no se registra como abono', () => {
    const c = abono({ causa: 'ERROR_IVA' }, { lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 0, tipoIva: 21 }], totalDocumento: undefined });
    expect(error(c).message).toMatch(/^Esta rectificativa no cambia ningún importe/);
  });

  it('un descuento o una devolución resta: el signo tiene que bajar el total', () => {
    const c = abono({}, { lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 40, tipoIva: 21 }], totalDocumento: undefined });
    expect(error(c)).toMatchObject({ message: 'Un descuento o una devolución resta: revisa el signo.', campo: 'lineas' });
    // Un error en el IVA puede subir o bajar, y mezclar tipos.
    const mixta = abono(
      { causa: 'ERROR_IVA' },
      {
        lineas: [
          { descripcion: 'Al 21 %', cantidad: 1, precioUnitario: -100, tipoIva: 21 },
          { descripcion: 'Al 10 %', cantidad: 1, precioUnitario: 100, tipoIva: 10 },
        ],
        totalDocumento: -11,
      },
    );
    expect(() => validarFacturaGasto(mixta)).not.toThrow();
  });

  it('un error en el IVA no cambia la base: la factura entera en negativo no vale', () => {
    const entera = abono(
      { causa: 'ERROR_IVA' },
      { lineas: [{ descripcion: 'Género', cantidad: 1, precioUnitario: -100, tipoIva: 21 }], totalDocumento: undefined },
    );
    expect(error(entera)).toMatchObject({ message: expect.stringMatching(/^Una rectificativa por un error en el IVA no cambia la base\./), campo: 'lineas' });
  });

  it('el total de la factura se cruza con signo', () => {
    expect(error(abono({}, { totalDocumento: 145.2 })).campo).toBe('totalDocumento');
  });

  it('el reparto entre varias originales tiene que sumar la rectificación', () => {
    const dos = (a: number, b: number) => abono({ originales: [{ id: 'a', base: a, cuota: -10.5 }, { id: 'b', base: b, cuota: -14.7 }] });
    expect(() => validarFacturaGasto(dos(-50, -70))).not.toThrow();
    expect(error(dos(-50, -60))).toMatchObject({
      message: 'El reparto entre las facturas que rectifica (-110,00 €) no suma la base de la rectificativa (-120,00 €).',
      campo: 'rectificativa.originales',
    });
    expect(error(abono({ originales: [{ id: 'a', base: -120 }, { id: 'b' }] })).campo).toBe('rectificativa.originales.1.base');
  });

  it('por sustitución: una sola original, y las líneas corregidas', () => {
    const s = (rect: Record<string, unknown>) => abono({ tipo: 'S', ...rect }, { lineas: undefined, totalDocumento: undefined });
    expect(error(s({}))).toMatchObject({ message: 'Por sustitución hacen falta las líneas de la factura corregida.', campo: 'rectificativa.corregida' });
    const corregida = { lineas: [{ descripcion: 'Género', cantidad: 1, precioUnitario: 800, tipoIva: 21 }] };
    expect(error(s({ corregida, originales: [{ id: 'a' }, { id: 'b' }] }))).toMatchObject({ campo: 'rectificativa.originales' });
    expect(error(s({ corregida, originales: [{ numero: 'F-1', fecha: '2027-01-10' }] }))).toMatchObject({ campo: 'rectificativa.importesOriginales' });
    const d = validarFacturaGasto(s({ corregida }));
    expect(d.rectificativa?.corregida?.lineas).toHaveLength(1);
  });

  it('por sustitución con una original de fuera: las líneas son la diferencia, con la cuota por tipo de los totales', () => {
    const d = validarFacturaGasto({
      ...abono(),
      lineas: undefined,
      totalDocumento: undefined,
      rectificativa: {
        tipo: 'S',
        causa: 'ERROR_IVA',
        originales: [{ numero: 'F-1', fecha: '2027-01-10' }],
        importesOriginales: {
          lineas: [
            { descripcion: 'a', cantidad: 1, precioUnitario: 0.07, tipoIva: 21 },
            { descripcion: 'b', cantidad: 1, precioUnitario: 0.07, tipoIva: 21 },
          ],
        },
        corregida: { lineas: [{ descripcion: 'c', cantidad: 1, precioUnitario: 0.14, tipoIva: 21 }] },
      },
    });
    // Base 0,14 en las dos; cuota 0,01 + 0,01 frente a 0,03: la diferencia es base 0 y cuota +0,01.
    expect(d.lineas).toEqual([expect.objectContaining({ cantidad: 1, precioUnitario: 0, tipoIva: 21, ivaFijado: 0.01 })]);
  });
});
