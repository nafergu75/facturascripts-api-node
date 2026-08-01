const fsClientMock = {
  listWithMeta: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

import {
  listarModelosImpuesto,
  buscarModelo,
  omitirModelo,
  recuperarModeloOmitido,
  marcarModeloListoParaPresentar,
  marcarModeloNoPresentado,
  autorrellenarModelo,
  guardarModeloManual,
  obtenerDetalleModelo,
  generarPdfModelo,
  exportarIngresosGastosExcel,
  fechaVencimientoModelo,
} from '../services/impuestosModulo.service';

const CO = 'imp-co';
const EJ = 2026;

describe('Modulo Impuestos (estilo Quipu)', () => {
  it('genera el calendario fiscal con dias hasta/desde vencimiento', async () => {
    const lista = await listarModelosImpuesto(CO, EJ, 'activos', '2026-04-10');
    expect(lista.length).toBe(19); // 4 modelos x 4T + 3 anuales
    const t1 = lista.find((m) => m.codigo === '303' && m.periodo === '1T')!;
    expect(t1.fechaVencimiento).toBe('2026-04-20');
    expect(t1.estado).toBe('vigente'); // verde
    expect(t1.diasHastaVencimiento).toBe(10);
    const m111t4 = await buscarModelo(CO, EJ, '111', '4T');
    expect(m111t4!.fechaVencimiento).toBe('2027-01-20'); // 111 4T = 20 enero
  });

  it('los vencidos quedan expirados (naranja) con dias transcurridos', async () => {
    const lista = await listarModelosImpuesto(CO, EJ, 'activos', '2026-04-25');
    const t1 = lista.find((m) => m.codigo === '303' && m.periodo === '1T')!;
    expect(t1.estado).toBe('expirado');
    expect(t1.diasDesdeVencimiento).toBe(5);
  });

  it('omitir saca de activos y recuperar lo devuelve', async () => {
    const m = (await buscarModelo(CO, EJ, '115', '1T'))!;
    await omitirModelo(CO, m.id);
    expect((await listarModelosImpuesto(CO, EJ, 'activos')).some((x) => x.id === m.id)).toBe(false);
    expect((await listarModelosImpuesto(CO, EJ, 'omitidos')).some((x) => x.id === m.id)).toBe(true);
    await recuperarModeloOmitido(CO, m.id);
    expect((await listarModelosImpuesto(CO, EJ, 'activos')).some((x) => x.id === m.id)).toBe(true);
  });

  it('listo-para-presentar mueve a presentados y no-presentado lo devuelve', async () => {
    const m = (await buscarModelo(CO, EJ, '111', '1T'))!;
    await marcarModeloListoParaPresentar(CO, m.id);
    expect((await listarModelosImpuesto(CO, EJ, 'presentados')).some((x) => x.id === m.id)).toBe(true);
    await marcarModeloNoPresentado(CO, m.id);
    expect((await listarModelosImpuesto(CO, EJ, 'activos')).some((x) => x.id === m.id)).toBe(true);
  });

  it('recalcular autorrellena, guarda automaticamente y pisa lo manual; guardar conserva lo manual', async () => {
    const m = (await buscarModelo(CO, EJ, '303', '2T'))!;

    // 1) "Recalcular importes" -> autorrelleno guardado automaticamente
    const auto = await autorrellenarModelo(CO, m.id);
    expect(auto.origen).toBe('autorrelleno');
    expect(auto.casillas).toHaveProperty('71_resultado');
    expect(auto.casillas).toHaveProperty('config_nif'); // configuracion incluida
    expect(auto.ficha.titulo).toContain('303');

    // persiste sin pulsar guardar (regla del video)
    const releido = await obtenerDetalleModelo(CO, m.id);
    expect(releido.origen).toBe('autorrelleno');

    // 2) edicion manual -> "Guardar" conserva y NO recalcula totales dependientes
    const manual = await guardarModeloManual(CO, m.id, { '01_base_devengada': 999, nota: 'ajuste manual' });
    expect(manual.origen).toBe('manual-mixto');
    expect(manual.casillas['01_base_devengada']).toBe(999);
    expect(manual.casillas['71_resultado']).toBe(auto.casillas['71_resultado']); // total NO recalculado

    // 3) "Recalcular importes" otra vez -> SE PIERDE lo manual
    const repisado = await autorrellenarModelo(CO, m.id);
    expect(repisado.origen).toBe('autorrelleno');
    expect(repisado.casillas['01_base_devengada']).not.toBe(999);
    expect(repisado.casillas).not.toHaveProperty('nota');
  });

  it('genera una copia PDF valida del modelo', async () => {
    const m = (await buscarModelo(CO, EJ, '303', '2T'))!;
    const { nombre, contenido } = await generarPdfModelo(CO, m.id);
    expect(nombre).toBe('303_2026_2T.pdf');
    expect(contenido.subarray(0, 5).toString()).toBe('%PDF-');
    expect(contenido.toString('latin1')).toContain('%%EOF');
  });

  it('exporta Excel de ingresos/gastos del periodo (xlsx valido)', async () => {
    const buf = await exportarIngresosGastosExcel(CO, { ejercicio: EJ, periodo: 'Q2' });
    expect(buf.subarray(0, 2).toString()).toBe('PK'); // zip/xlsx magic
  });

  it('exporta Excel filtrando por MES (rango 01..fin de mes)', async () => {
    fsClientMock.listWithMeta.mockClear();
    const buf = await exportarIngresosGastosExcel(CO, { ejercicio: EJ, periodo: '02' });
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const params = fsClientMock.listWithMeta.mock.calls.find((c) => c[0] === 'facturaclientes')![1];
    expect(params['filter[fecha_gte]']).toBe('2026-02-01');
    expect(params['filter[fecha_lte]']).toBe('2026-02-28');
  });

  it('plazos AEAT correctos para anuales', () => {
    expect(fechaVencimientoModelo('390', 2026, '0A')).toBe('2027-01-30');
    expect(fechaVencimientoModelo('347', 2026, '0A')).toBe('2027-02-28');
    expect(fechaVencimientoModelo('200', 2026, '0A')).toBe('2027-07-25');
  });
});

