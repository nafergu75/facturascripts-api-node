/**
 * Correcciones de una venta leida (lectura/correcciones-venta.ts), sin BD:
 * forma del bloque `correcciones` y el campo de cada 400, desglose y reparto
 * de cuotas por tipo, mapa de campos, cambios para el AuditLog y el QR otra vez.
 */
import { HttpError } from '../utils/http-errors';
import {
  aplicarCorrecciones,
  campoDeCorreccion,
  cambiosCorregidos,
  cuotasFijasPorTipo,
  leerCorrecciones,
  qrInterpretadoDe,
  textoCorregidos,
  tipoRetencionLeido,
  type CorreccionesVenta,
} from '../services/lectura/correcciones-venta';
import { lecturaVacia, type LecturaNormalizada } from '../services/lectura/tipos';
import { compararQr } from '../services/lectura/verifactu-qr';
import { validacionesSincronas } from '../services/lectura/validaciones';

const ES = { espanola: true, rectificativa: false };

/** El 400 que lanza fn, con su codigo y su campo. */
function error400(fn: () => unknown): { codigo?: string; campo?: string; message: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    const h = e as HttpError & { details?: { codigo?: string; campo?: string } };
    expect(h.statusCode).toBe(400);
    return { ...(h.details ?? {}), message: h.message };
  }
  throw new Error('no ha lanzado');
}

/** Una venta leida de 200 € al 21 % (242 €), con su numero y su fecha. */
function leida(): LecturaNormalizada {
  const l = lecturaVacia('azure');
  l.numero = { valor: 'F2026/0012', confianza: 0.95, fuente: 'azure' };
  l.fechaEmision = { valor: '2026-03-04', confianza: 0.95, fuente: 'azure' };
  l.fechaVencimiento = { valor: '2026-04-03', confianza: 0.95, fuente: 'azure' };
  l.concepto = { valor: 'Folletos', confianza: 0.9, fuente: 'azure' };
  l.desglose = [{ tipoIva: 21, base: { valor: 200, confianza: 0.9, fuente: 'azure' }, cuota: { valor: 42, confianza: 0.9, fuente: 'azure' }, tipoRecargo: null, cuotaRecargo: null }];
  l.totales.base = { valor: 200, confianza: 0.9, fuente: 'azure' };
  l.totales.cuotaIva = { valor: 42, confianza: 0.9, fuente: 'azure' };
  l.totales.totalFactura = { valor: 242, confianza: 0.9, fuente: 'azure' };
  l.totales.totalAPagar = { valor: 242, confianza: 0.9, fuente: 'azure' };
  l.emisor.nif = { valor: 'B12345674', confianza: 0.9, fuente: 'azure' };
  l.receptor.nif = { valor: 'B87654323', confianza: 0.9, fuente: 'azure' };
  return l;
}

describe('leerCorrecciones: forma y campo de cada 400', () => {
  it('sin bloque o vacío: null', () => {
    expect(leerCorrecciones(undefined, ES)).toBeNull();
    expect(leerCorrecciones(null, ES)).toBeNull();
    expect(leerCorrecciones({}, ES)).toBeNull();
  });

  it('lo que no es un objeto y los datos desconocidos: CORRECCION_NO_VALIDA', () => {
    expect(error400(() => leerCorrecciones([1], ES))).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'correcciones' });
    expect(error400(() => leerCorrecciones('x', ES))).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'correcciones' });
    expect(error400(() => leerCorrecciones({ cliente: 'x' }, ES))).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'correcciones.cliente' });
  });

  it('número, fechas y concepto', () => {
    expect(error400(() => leerCorrecciones({ numero: '  ' }, ES))).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'correcciones.numero' });
    expect(error400(() => leerCorrecciones({ numero: 'x'.repeat(61) }, ES))).toMatchObject({ campo: 'correcciones.numero' });
    expect(error400(() => leerCorrecciones({ fechaEmision: '2026-02-30' }, ES))).toMatchObject({ campo: 'correcciones.fechaEmision' });
    expect(error400(() => leerCorrecciones({ fechaVencimiento: '04/03/2026' }, ES))).toMatchObject({ campo: 'correcciones.fechaVencimiento' });
    expect(error400(() => leerCorrecciones({ concepto: 'x'.repeat(501) }, ES))).toMatchObject({ campo: 'correcciones.concepto' });
    expect(leerCorrecciones({ numero: ' F-7 ', fechaEmision: '2026-03-05', fechaVencimiento: null, concepto: '  Folletos   y  carteles ' }, ES)).toEqual({
      numero: 'F-7',
      fechaEmision: '2026-03-05',
      fechaVencimiento: null,
      concepto: 'Folletos y carteles',
    });
    expect(leerCorrecciones({ concepto: '   ' }, ES)).toEqual({ concepto: null });
  });

  it('líneas: número, base con dos decimales, tipo de IVA y cuenta', () => {
    expect(error400(() => leerCorrecciones({ lineas: [], total: 1 }, ES))).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'correcciones.lineas' });
    const muchas = Array.from({ length: 51 }, () => ({ descripcion: 'x', base: 1, tipoIva: 21 }));
    expect(error400(() => leerCorrecciones({ lineas: muchas, total: 1 }, ES))).toMatchObject({ campo: 'correcciones.lineas' });
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x', base: 1.234, tipoIva: 21 }], total: 1 }, ES))).toMatchObject({ campo: 'correcciones.lineas.0.base' });
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x', base: '10', tipoIva: 21 }], total: 1 }, ES))).toMatchObject({ campo: 'correcciones.lineas.0.base' });
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x', base: 10, tipoIva: 7 }], total: 1 }, ES))).toMatchObject({ campo: 'correcciones.lineas.0.tipoIva' });
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x'.repeat(501), base: 10, tipoIva: 21 }], total: 1 }, ES))).toMatchObject({ campo: 'correcciones.lineas.0.descripcion' });
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x', base: 10, tipoIva: 21, cuenta: 705 }], total: 1 }, ES))).toMatchObject({ campo: 'correcciones.lineas.0.cuenta' });
    const c = leerCorrecciones({ lineas: [{ descripcion: ' Folletos ', base: 100, tipoIva: 21, cuenta: ' 70.5 ' }, { base: 50, tipoIva: 0 }], total: 171 }, ES);
    expect(c?.lineas).toEqual([
      { descripcion: 'Folletos', base: 100, tipoIva: 21, cuenta: '705' },
      { descripcion: '', base: 50, tipoIva: 0, cuenta: null },
    ]);
  });

  it('base en negativo: solo en una rectificativa (IMPORTE_NEGATIVO)', () => {
    const cuerpo = { lineas: [{ descripcion: 'Devolución', base: -100, tipoIva: 21 }], total: -121 };
    expect(error400(() => leerCorrecciones(cuerpo, ES))).toMatchObject({ codigo: 'IMPORTE_NEGATIVO', campo: 'correcciones.lineas.0.base' });
    expect(leerCorrecciones(cuerpo, { espanola: true, rectificativa: true })?.lineas?.[0].base).toBe(-100);
  });

  it('empresa de fuera de España: sin IVA español (SIN_IVA_ESPANOL)', () => {
    const fuera = { espanola: false, rectificativa: false };
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x', base: 100, tipoIva: 21 }], total: 121 }, fuera))).toMatchObject({
      codigo: 'SIN_IVA_ESPANOL',
      campo: 'correcciones.lineas.0.tipoIva',
    });
    expect(leerCorrecciones({ lineas: [{ descripcion: 'x', base: 100, tipoIva: 0 }], total: 100 }, fuera)?.total).toBe(100);
  });

  it('retención y total: el total es obligatorio con líneas o retención (FALTA_TOTAL)', () => {
    expect(error400(() => leerCorrecciones({ tipoRetencion: 60, total: 1 }, ES))).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'correcciones.tipoRetencion' });
    expect(error400(() => leerCorrecciones({ total: 1.001 }, ES))).toMatchObject({ campo: 'correcciones.total' });
    expect(error400(() => leerCorrecciones({ tipoRetencion: 15 }, ES))).toMatchObject({ codigo: 'FALTA_TOTAL', campo: 'correcciones.total' });
    expect(error400(() => leerCorrecciones({ lineas: [{ descripcion: 'x', base: 1, tipoIva: 21 }] }, ES))).toMatchObject({ codigo: 'FALTA_TOTAL', campo: 'correcciones.total' });
    expect(leerCorrecciones({ total: 242 }, ES)).toEqual({ total: 242 });
  });
});

describe('cuotasFijasPorTipo: la cuota del tipo sobre la suma de bases, repartida al céntimo', () => {
  it('una línea por tipo: la cuota de siempre; exento, 0', () => {
    expect(cuotasFijasPorTipo([{ base: 200, tipoIva: 21 }, { base: 50, tipoIva: 10 }, { base: 30, tipoIva: 0 }])).toEqual([42, 5, 0]);
  });

  it('dos líneas del mismo tipo: la cuota sale de la suma (0,21) y no de cada línea (0,11 + 0,11)', () => {
    expect(cuotasFijasPorTipo([{ base: 1.05, tipoIva: 10 }, { base: 1.05, tipoIva: 10 }])).toEqual([0.1, 0.11]);
  });

  it('en negativo (abono), el espejo de la factura', () => {
    expect(cuotasFijasPorTipo([{ base: -1.05, tipoIva: 10 }, { base: -1.05, tipoIva: 10 }])).toEqual([-0.1, -0.11]);
  });

  it('una factura partida en la 700 y la 705 cuadra con la cuota de la factura', () => {
    const cuotas = cuotasFijasPorTipo([{ base: 123.45, tipoIva: 21 }, { base: 76.57, tipoIva: 21 }]);
    expect(Math.round((cuotas[0] + cuotas[1]) * 100)).toBe(Math.round(200.02 * 21)); // 42,00 €
  });
});

describe('aplicarCorrecciones', () => {
  it('número, fechas y concepto con fuente manual; lo demás como se leyó', () => {
    const c: CorreccionesVenta = { numero: 'F2026/0013', fechaEmision: '2026-03-05', fechaVencimiento: null, concepto: 'Carteles' };
    const l = aplicarCorrecciones(leida(), c);
    expect(l.numero).toEqual({ valor: 'F2026/0013', confianza: null, fuente: 'manual' });
    expect(l.fechaEmision.valor).toBe('2026-03-05');
    expect(l.fechaVencimiento.valor).toBeNull();
    expect(l.concepto.valor).toBe('Carteles');
    expect(l.desglose).toEqual(leida().desglose);
    expect(l.totales.totalAPagar.valor).toBe(242);
  });

  it('líneas: un tramo por tipo con la suma de bases y su cuota, retención recalculada y el total escrito', () => {
    const c: CorreccionesVenta = {
      lineas: [
        { descripcion: 'Diseño', base: 100, tipoIva: 21, cuenta: '705' },
        { descripcion: 'Impresión', base: 100, tipoIva: 21, cuenta: '700' },
        { descripcion: 'Libros', base: 50, tipoIva: 4 },
      ],
      tipoRetencion: 15,
      total: 214.5,
    };
    const l = aplicarCorrecciones(leida(), c);
    expect(l.desglose.map((t) => [t.tipoIva, t.base.valor, t.cuota.valor, t.base.fuente])).toEqual([
      [21, 200, 42, 'manual'],
      [4, 50, 2, 'manual'],
    ]);
    expect(l.retencion?.tipo.valor).toBe(15);
    expect(l.retencion?.importe.valor).toBe(37.5);
    expect(l.totales.totalFactura.valor).toBe(294);
    expect(l.totales.totalAPagar).toEqual({ valor: 214.5, confianza: null, fuente: 'manual' });
    expect(l.lineas.map((x) => x.descripcion)).toEqual(['Diseño', 'Impresión', 'Libros']);
  });

  it('la retención a 0 la quita; con lo escrito que no cuadra, la validación de siempre lo dice (CUADRE en el total)', () => {
    const conRetencion = leida();
    conRetencion.retencion = { tipo: { valor: 15, confianza: 0.9, fuente: 'azure' }, importe: { valor: 30, confianza: 0.9, fuente: 'azure' } };
    const sin = aplicarCorrecciones(conRetencion, { tipoRetencion: 0, total: 242 });
    expect(sin.retencion).toBeNull();
    expect(sin.totales.retencion.valor).toBe(0);
    const mal = aplicarCorrecciones(leida(), { total: 250 });
    const v = validacionesSincronas(mal, { lector: 'VENTA', nifEmpresa: 'B12345674', empresaEspanola: true, monedaCuenta: 'EUR', hoy: '2026-10-14', periodoAbierto: async () => true, duplicado: { factura: null, archivo: null } });
    expect(v.find((x) => x.codigo === 'CUADRE')).toMatchObject({ nivel: 'error', campos: ['totales.totalAPagar'] });
  });

  it('recargo de equivalencia leído: sin tocar las líneas sigue bloqueando; corregidas, va sin recargo y el AuditLog guarda el leído', () => {
    const conRecargo = leida();
    conRecargo.desglose[0] = { ...conRecargo.desglose[0], tipoRecargo: 5.2, cuotaRecargo: { valor: 10.4, confianza: 0.9, fuente: 'azure' } };
    conRecargo.totales.totalFactura.valor = 252.4;
    conRecargo.totales.totalAPagar.valor = 252.4;
    const ctx = { lector: 'VENTA' as const, nifEmpresa: 'B12345674', empresaEspanola: true, monedaCuenta: 'EUR', hoy: '2026-10-14', periodoAbierto: async () => true, duplicado: { factura: null, archivo: null } };
    expect(validacionesSincronas(aplicarCorrecciones(conRecargo, { numero: 'F-9' }), ctx).find((v) => v.codigo === 'RECARGO_NO_SOPORTADO')?.nivel).toBe('error');
    const c: CorreccionesVenta = { lineas: [{ descripcion: 'Folletos', base: 200, tipoIva: 21 }], total: 242 };
    const corregida = aplicarCorrecciones(conRecargo, c);
    expect(corregida.desglose[0]).toMatchObject({ tipoRecargo: null, cuotaRecargo: null });
    expect(validacionesSincronas(corregida, ctx).some((v) => v.codigo === 'RECARGO_NO_SOPORTADO' || v.codigo === 'CUADRE')).toBe(false);
    expect(cambiosCorregidos(conRecargo, c)[0]).toMatchObject({ campo: 'lineas', leido: [{ tipoIva: 21, base: 200, cuota: 42, recargo: 10.4 }] });
  });

  it('retención leída sin porcentaje: el que sale del importe sobre la base, con las líneas o solo el total corregidos', () => {
    // 1.000 € al 21 % con 150 € de retención y sin el porcentaje (la IA no lo ve): 1.060 € a cobrar.
    const sinTipo = leida();
    sinTipo.desglose = [{ tipoIva: 21, base: { valor: 1000, confianza: 0.9, fuente: 'claude' }, cuota: { valor: 210, confianza: 0.9, fuente: 'claude' }, tipoRecargo: null, cuotaRecargo: null }];
    sinTipo.retencion = { tipo: { valor: null, confianza: null, fuente: 'claude' }, importe: { valor: 150, confianza: null, fuente: 'claude' } };
    sinTipo.totales.retencion = { valor: 150, confianza: null, fuente: 'claude' };
    sinTipo.totales.totalAPagar = { valor: 1060, confianza: 0.9, fuente: 'claude' };
    expect(tipoRetencionLeido(sinTipo)).toBe(15);
    const ctx = { lector: 'VENTA' as const, nifEmpresa: 'B12345674', empresaEspanola: true, monedaCuenta: 'EUR', hoy: '2026-10-14', periodoAbierto: async () => true, duplicado: { factura: null, archivo: null } };

    const partida = aplicarCorrecciones(sinTipo, { lineas: [{ descripcion: 'Diseño', base: 600, tipoIva: 21 }, { descripcion: 'Impresión', base: 400, tipoIva: 21 }], total: 1060 });
    expect(partida.retencion?.tipo).toMatchObject({ valor: 15, fuente: 'calculado' });
    expect(partida.retencion?.importe.valor).toBe(150);
    expect(validacionesSincronas(partida, ctx).some((v) => v.codigo === 'CUADRE')).toBe(false);

    const soloTotal = aplicarCorrecciones(sinTipo, { total: 1060 });
    expect(soloTotal.retencion?.importe.valor).toBe(150);
    expect(validacionesSincronas(soloTotal, ctx).some((v) => v.codigo === 'CUADRE')).toBe(false);

    // Lo escrito manda; sin retención leída, 0; y un importe que no da un porcentaje entero se redondea (y no cuadrará).
    expect(aplicarCorrecciones(sinTipo, { tipoRetencion: 7, total: 1140 }).retencion?.tipo).toMatchObject({ valor: 7, fuente: 'manual' });
    expect(tipoRetencionLeido(leida())).toBe(0);
    const raro = structuredClone(sinTipo);
    raro.retencion!.importe.valor = 46.7;
    expect(tipoRetencionLeido(raro)).toBe(5);
  });

  it('el QR se coteja otra vez: un número corregido que lo contradice es un error', () => {
    const conQr = compararQr({ estado: 'VALIDO', verifactu: true, datos: { nif: 'B12345674', numserie: 'F2026/0012', fecha: '2026-03-04', importe: 242 } }, leida());
    expect(conQr.qr?.estado).toBe('COINCIDE');
    const igual = aplicarCorrecciones(conQr, { concepto: 'Otro' });
    expect(igual.qr?.estado).toBe('COINCIDE');
    const otro = aplicarCorrecciones(conQr, { numero: 'F2026/0099' });
    expect(otro.qr?.estado).toBe('NO_COINCIDE');
    expect(otro.qr?.diferencias).toEqual([{ campo: 'numero', enQr: 'F2026/0012', leido: 'F2026/0099', nivel: 'error' }]);
    // Sin QR: sigue sin QR.
    expect(aplicarCorrecciones(leida(), { numero: 'F-1' }).qr).toBeNull();
  });
});

describe('qrInterpretadoDe', () => {
  it('vuelve a la forma sin comparar', () => {
    expect(qrInterpretadoDe(null)).toBeNull();
    expect(qrInterpretadoDe({ estado: 'SIN_QR', verifactu: null, datos: null, diferencias: [] })).toBeNull();
    expect(qrInterpretadoDe({ estado: 'AJENO', verifactu: null, datos: null, diferencias: [] })).toEqual({ estado: 'AJENO', verifactu: null, datos: null });
    expect(qrInterpretadoDe({ estado: 'NO_COINCIDE', verifactu: null, datos: null, diferencias: [], pruebas: true, motivo: 'x' })?.estado).toBe('PRUEBAS');
    expect(qrInterpretadoDe({ estado: 'ILEGIBLE', verifactu: true, datos: null, diferencias: [] })).toEqual({ estado: 'ILEGIBLE', verifactu: true, datos: null });
    const datos = { nif: 'B1', numserie: 'F-1', fecha: '2026-01-01', importe: 1 };
    expect(qrInterpretadoDe({ estado: 'NO_COINCIDE', verifactu: true, datos, diferencias: [] })).toEqual({ estado: 'VALIDO', verifactu: true, datos });
  });
});

describe('campoDeCorreccion', () => {
  const c: CorreccionesVenta = { lineas: [{ descripcion: 'a', base: 100, tipoIva: 21 }, { descripcion: 'b', base: 10, tipoIva: 10 }], total: 132 };
  const lc = aplicarCorrecciones(leida(), c);
  it('lleva cada campo de la lectura al de la corrección', () => {
    expect(campoDeCorreccion('numero', c, lc)).toBe('correcciones.numero');
    expect(campoDeCorreccion('fechaEmision', c, lc)).toBe('correcciones.fechaEmision');
    expect(campoDeCorreccion('desglose.1.base', c, lc)).toBe('correcciones.lineas.1.base');
    expect(campoDeCorreccion('desglose.1.base', c, lc, 'TIPO_IVA')).toBe('correcciones.lineas.1.tipoIva');
    expect(campoDeCorreccion('desglose.0.cuota', c, lc)).toBe('correcciones.lineas.0.base');
    expect(campoDeCorreccion('desglose.0.base', null, leida())).toBe('correcciones.lineas');
    expect(campoDeCorreccion('retencion.importe', c, lc)).toBe('correcciones.tipoRetencion');
    expect(campoDeCorreccion('totales.totalAPagar', c, lc)).toBe('correcciones.total');
    expect(campoDeCorreccion('receptor.nif', c, lc)).toBe('clienteId');
    expect(campoDeCorreccion('emisor.nif', c, lc)).toBeNull();
    expect(campoDeCorreccion('moneda', c, lc)).toBeNull();
    expect(campoDeCorreccion(undefined, c, lc)).toBeNull();
  });
});

describe('cambiosCorregidos y textoCorregidos', () => {
  it('lo leído y lo puesto, sin lo que no cambia ni las cuentas', () => {
    const c: CorreccionesVenta = { numero: 'F2026/0012', fechaEmision: '2026-03-05', lineas: [{ descripcion: 'x', base: 200, tipoIva: 21, cuenta: '705' }], total: 242 };
    expect(cambiosCorregidos(leida(), c)).toEqual([
      { campo: 'fechaEmision', leido: '2026-03-04', puesto: '2026-03-05' },
      { campo: 'lineas', leido: [{ tipoIva: 21, base: 200, cuota: 42 }], puesto: [{ descripcion: 'x', base: 200, tipoIva: 21 }] },
    ]);
    expect(textoCorregidos(c)).toBe('número, fecha, líneas y total');
    expect(textoCorregidos({ total: 1 })).toBe('total');
  });

  it('rellenada a mano: lo leído va a null', () => {
    expect(cambiosCorregidos(null, { numero: 'F-1', total: 10 })).toEqual([
      { campo: 'numero', leido: null, puesto: 'F-1' },
      { campo: 'total', leido: null, puesto: 10 },
    ]);
  });
});
