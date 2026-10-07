/**
 * Carmen: normalización del texto, huecos (periodo, modelo, factura, importe,
 * NIF) y búsqueda de terceros. Sin BD: Prisma simulado.
 */
const mockPrisma = {
  customer: { findMany: jest.fn() },
  supplier: { findMany: jest.fn() },
  bankAccount: { findMany: jest.fn() },
};
jest.mock('../config/database', () => ({ prisma: mockPrisma }));

import { normalizar, distanciaEdicion } from '../services/carmen/normalizar';
import { extraerPeriodo, resolverCodigoPeriodo } from '../services/carmen/huecos/periodo';
import { extraerFoco, extraerImporteMinimo, extraerModelo, extraerNif, extraerNumeroFactura, extraerSentido } from '../services/carmen/huecos/otros';
import { buscarEnIndice, buscarTercero, olvidarIndices, tokensBanco, tokensNombre, type Tercero } from '../services/carmen/terceros';
import { sinTildes } from '../utils/texto';

const HOY = '2026-10-07';

describe('normalizar', () => {
  it('quita tildes y signos, y conserva la ñ', () => {
    expect(sinTildes('¿Cuánto IVA pagué en el año?')).toBe('¿Cuanto IVA pague en el año?');
    expect(normalizar('¿Cuánto me DEBE García?').texto).toBe('cuanto me debe garcia');
  });

  it('pasa los importes en formato español a número', () => {
    expect(normalizar('movimientos de más de 1.000 €').texto).toBe('movimientos de mas de 1000 euros');
    expect(normalizar('una factura de 1.234,56 euros').texto).toContain('1234.56');
    // Fechas y números de factura no se tocan.
    expect(normalizar('del 15/12 al 15/01').texto).toBe('del 15/12 al 15/01');
    expect(normalizar('busca la factura 2026-0045').texto).toBe('busca la factura 2026-0045');
  });

  it('expande las abreviaturas', () => {
    expect(normalizar('fras del 3T').texto).toBe('facturas del tercer trimestre');
    expect(normalizar('lo q me deve el cli').texto).toBe('lo que me debe el cliente');
    expect(normalizar('pyg').texto).toBe('perdidas y ganancias');
  });

  it('corrige faltas solo hacia palabras del dominio', () => {
    expect(normalizar('cuanto factire el mes pasado').texto).toBe('cuanto facture el mes pasado');
    expect(normalizar('facturas bencidas').texto).toBe('facturas vencidas');
    // Nombres y palabras sin parecido se quedan como están.
    expect(normalizar('cuanto me debe iberdrola').texto).toBe('cuanto me debe iberdrola');
    expect(normalizar('que gastos puedo deducir siendo autonomo').texto).toContain('siendo');
    expect(normalizar('buenos dias').texto).toBe('buenos dias');
  });

  it('distancia de Damerau-Levenshtein con transposiciones', () => {
    expect(distanciaEdicion('factura', 'fatcura')).toBe(1);
    expect(distanciaEdicion('deve', 'debe')).toBe(1);
    expect(distanciaEdicion('abc', 'xyz', 1)).toBeGreaterThan(1);
  });
});

describe('hueco periodo (hoy = 07/10/2026)', () => {
  const p = (t: string, hoy = HOY) => extraerPeriodo(normalizar(t).texto, hoy)?.periodo;

  it('este trimestre, el trimestre pasado y el 4T', () => {
    expect(p('este trimestre')).toMatchObject({ desde: '2026-10-01', hasta: '2026-12-31', codigo: 'este-trimestre' });
    expect(p('el trimestre pasado')).toMatchObject({ desde: '2026-07-01', hasta: '2026-09-30' });
    expect(p('el 4T')).toMatchObject({ desde: '2026-10-01', hasta: '2026-12-31' });
    expect(p('el 3T de 2025')).toMatchObject({ desde: '2025-07-01', hasta: '2025-09-30' });
  });

  it('un mes sin año es el más reciente que ya ha empezado', () => {
    expect(p('en septiembre')).toMatchObject({ desde: '2026-09-01', hasta: '2026-09-30' });
    expect(p('en noviembre')).toMatchObject({ desde: '2025-11-01', hasta: '2025-11-30' });
    expect(p('marzo de 2024')).toMatchObject({ desde: '2024-03-01', hasta: '2024-03-31' });
  });

  it('rango que cruza de ejercicio: dos ejercicios', () => {
    expect(p('del 15/12 al 15/01')).toMatchObject({ desde: '2025-12-15', hasta: '2026-01-15', ejercicios: [2025, 2026] });
    expect(p('del 1/9/2026 al 30/9/2026')).toMatchObject({ desde: '2026-09-01', hasta: '2026-09-30', ejercicios: [2026] });
  });

  it('en lo que va de año, este mes, el mes pasado, hoy', () => {
    expect(p('en lo que va de año')).toMatchObject({ desde: '2026-01-01', hasta: '2026-12-31', codigo: 'este-anio' });
    expect(p('este mes')).toMatchObject({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(p('el mes pasado')).toMatchObject({ desde: '2026-09-01', hasta: '2026-09-30' });
    expect(p('que ha entrado hoy')).toMatchObject({ desde: HOY, hasta: HOY });
    expect(p('el año pasado')).toMatchObject({ desde: '2025-01-01', hasta: '2025-12-31' });
  });

  it('a 10/01, el trimestre pasado es el 4T del año anterior', () => {
    expect(p('el trimestre pasado', '2026-01-10')).toMatchObject({ desde: '2025-10-01', hasta: '2025-12-31' });
    expect(p('el 4T', '2026-01-10')).toMatchObject({ desde: '2025-10-01', hasta: '2025-12-31' });
  });

  it('un año no se confunde con el principio de un número de factura', () => {
    expect(p('busca la factura 2026-0045')).toBeUndefined();
    expect(p('PyG de 2025')).toMatchObject({ desde: '2025-01-01', hasta: '2025-12-31' });
  });

  it('los códigos de los botones se resuelven con la fecha de hoy', () => {
    expect(resolverCodigoPeriodo('mes-pasado', HOY)).toMatchObject({ desde: '2026-09-01' });
    expect(resolverCodigoPeriodo('2026-3T', HOY)).toMatchObject({ desde: '2026-07-01', hasta: '2026-09-30' });
    expect(resolverCodigoPeriodo('2026-13', HOY)).toBeNull();
    expect(resolverCodigoPeriodo('2026-02-30_2026-03-01', HOY)).toBeNull();
    expect(resolverCodigoPeriodo('cualquier-cosa', HOY)).toBeNull();
  });
});

describe('periodos hacia delante (vencimientos)', () => {
  const p = (t: string, hoy = HOY) => extraerPeriodo(normalizar(t).texto, hoy)?.periodo;
  it('«la semana que viene» y «el mes que viene»', () => {
    // 07/10/2026 es miércoles: la semana que viene va del lunes 12 al domingo 18.
    expect(p('que tengo que pagar la semana que viene')).toMatchObject({ desde: '2026-10-12', hasta: '2026-10-18', codigo: 'semana-que-viene' });
    expect(p('pagos de la proxima semana')).toMatchObject({ codigo: 'semana-que-viene' });
    expect(p('que vence el mes que viene')).toMatchObject({ desde: '2026-11-01', hasta: '2026-11-30', codigo: 'mes-que-viene' });
    expect(p('que vence el proximo mes', '2026-12-10')).toMatchObject({ desde: '2027-01-01', hasta: '2027-01-31' });
  });

  it('«viene» no se corrige a «tiene»', () => {
    expect(normalizar('la semana que viene').texto).toBe('la semana que viene');
  });
});

describe('otros huecos', () => {
  it('foco de INT-09: facturado (ventas) o gastado (gastos)', () => {
    expect(extraerFoco('cuanto he facturado este trimestre')).toBe('ventas');
    expect(extraerFoco('ventas de septiembre')).toBe('ventas');
    expect(extraerFoco('cuanto he gastado este año')).toBe('gastos');
    expect(extraerFoco('total de compras del trimestre')).toBe('gastos');
    expect(extraerFoco('facturas de proveedores del mes')).toBe('gastos');
    expect(extraerFoco('facturado y gastado este año')).toBeNull();
  });

  it('modelo, número de factura, importe mínimo, NIF y sentido', () => {
    expect(extraerModelo('el 303 del tercer trimestre')).toBe('303');
    expect(extraerModelo('la factura 303')).toBeNull();
    expect(extraerNumeroFactura('busca la factura 2026-0045')).toBe('2026-0045');
    expect(extraerNumeroFactura('esta cobrada la a-12')).toBe('A-12');
    expect(extraerNumeroFactura('el iva de 2026')).toBeNull();
    expect(extraerImporteMinimo('movimientos de mas de 1000 euros')).toBe(1000);
    expect(extraerNif('el cliente B12345674 me debe')).toBe('B12345674');
    expect(extraerSentido('cuanto he cobrado')).toBe('cobros');
    expect(extraerSentido('cuanto he pagado')).toBe('pagos');
  });
});

describe('terceros', () => {
  const t = (id: string, rol: Tercero['rol'], nombre: string, nif?: string): Tercero => ({ id, rol, nombre, tokens: tokensNombre(nombre), nif });
  const indice: Tercero[] = [
    t('c1', 'cliente', 'CONSTRUCCIONES PÉREZ, S.L.', 'B11111111'),
    t('c2', 'cliente', 'Talleres Martínez SA', 'A22222222'),
    t('p1', 'proveedor', 'IBERDROLA CLIENTES S.A.U.', 'A44444444'),
  ];

  it('quita las formas jurídicas', () => {
    expect(tokensNombre('Construcciones Pérez, S.L.')).toEqual(['construcciones', 'perez']);
    expect(tokensNombre('IBERDROLA CLIENTES S.A.U.')).toEqual(['iberdrola', 'clientes']);
    expect(tokensNombre('Bar Pepe C.B.')).toEqual(['bar', 'pepe']);
  });

  it('«const perez» encuentra a CONSTRUCCIONES PÉREZ SL', () => {
    const r = buscarEnIndice(normalizar('cuanto me debe const perez').base, indice);
    expect(r).toMatchObject({ tipo: 'unico', tercero: { id: 'c1' } });
  });

  it('dos Pérez parecidos: pregunta con botones', () => {
    const conDos = [...indice, t('c3', 'cliente', 'PÉREZ GARCÍA JUAN')];
    const r = buscarEnIndice(normalizar('cuanto me debe perez').base, conDos);
    expect(r?.tipo).toBe('dudas');
    expect(r && r.tipo === 'dudas' ? r.candidatos.map((c) => c.tercero.id).sort() : []).toEqual(['c1', 'c3']);
  });

  it('un NIF exacto gana', () => {
    expect(buscarEnIndice(normalizar('que me debe a22222222').base, indice)).toMatchObject({ tipo: 'unico', tercero: { id: 'c2' }, puntuacion: 1 });
  });

  it('sin parecido: no encuentra y no confunde palabras del dominio con nombres', () => {
    expect(buscarEnIndice(normalizar('quien me debe dinero').base, indice)).toBeNull();
    expect(buscarEnIndice(normalizar('cuanto me debe zapatero').base, indice)).toMatchObject({ tipo: 'ninguno', trozo: 'zapatero' });
  });

  it('un cliente creado después de cargar la caché se encuentra con el refresco', async () => {
    olvidarIndices();
    const ahora = Date.now();
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(ahora);
    mockPrisma.customer.findMany.mockResolvedValueOnce([{ id: 'c1', nombreFiscal: 'CONSTRUCCIONES PÉREZ SL', nifCif: 'B11111111' }]);
    mockPrisma.supplier.findMany.mockResolvedValue([]);
    mockPrisma.bankAccount.findMany.mockResolvedValue([]);
    expect(await buscarTercero('E1', normalizar('cuanto me debe construcciones perez').base)).toMatchObject({ tipo: 'unico' });

    // Pasa más de un minuto y se da de alta Hermanos Ruiz.
    reloj.mockReturnValue(ahora + 61_000);
    mockPrisma.customer.findMany.mockResolvedValueOnce([
      { id: 'c1', nombreFiscal: 'CONSTRUCCIONES PÉREZ SL', nifCif: 'B11111111' },
      { id: 'c9', nombreFiscal: 'HERMANOS RUIZ SL', nifCif: 'B99999999' },
    ]);
    expect(await buscarTercero('E1', normalizar('cuanto me debe hermanos ruiz').base)).toMatchObject({ tipo: 'unico', tercero: { id: 'c9' } });
    reloj.mockRestore();
  });
});

// ---------------- Correcciones de la revisión (07-10-2026) ----------------

describe('revisión: periodos (hoy = 07/10/2026)', () => {
  const p = (t: string, hoy = HOY) => extraerPeriodo(normalizar(t).texto, hoy)?.periodo;

  it('«del año pasado», «del ejercicio anterior» y «de este año» detrás de un trimestre o de un mes', () => {
    expect(p('el 303 del primer trimestre del año pasado')).toMatchObject({ desde: '2025-01-01', hasta: '2025-03-31', codigo: '2025-1T' });
    expect(p('beneficio del cuarto trimestre del año pasado')).toMatchObject({ desde: '2025-10-01', hasta: '2025-12-31' });
    expect(p('el tercer trimestre del ejercicio anterior')).toMatchObject({ desde: '2025-07-01' });
    expect(p('el cuarto trimestre de este año')).toMatchObject({ desde: '2026-10-01', hasta: '2026-12-31' });
    expect(p('cuanto facture en marzo del año pasado')).toMatchObject({ desde: '2025-03-01', hasta: '2025-03-31', codigo: '2025-03' });
    expect(p('ventas de noviembre de este año')).toMatchObject({ desde: '2026-11-01' });
    // Lo de antes sigue igual.
    expect(p('el 3T de 2025')).toMatchObject({ desde: '2025-07-01' });
    expect(p('marzo 2024')).toMatchObject({ desde: '2024-03-01' });
    expect(p('en noviembre')).toMatchObject({ desde: '2025-11-01' });
  });

  it('un rango sin año empieza en la fecha más reciente que ya ha llegado; el final, en el mismo año', () => {
    expect(p('del 1/10 al 31/10')).toMatchObject({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(p('del 1/10 al 15/10')).toMatchObject({ desde: '2026-10-01', hasta: '2026-10-15' });
    expect(p('del 15 de septiembre al 15 de octubre')).toMatchObject({ desde: '2026-09-15', hasta: '2026-10-15' });
    expect(p('del 1/3 al 15/3')).toMatchObject({ desde: '2026-03-01', hasta: '2026-03-15' });
    // El que empieza después de hoy es del año pasado; si el final queda antes, del siguiente.
    expect(p('del 15/12 al 15/01')).toMatchObject({ desde: '2025-12-15', hasta: '2026-01-15', ejercicios: [2025, 2026] });
    expect(p('del 1/11 al 30/11')).toMatchObject({ desde: '2025-11-01', hasta: '2025-11-30' });
    // Con un solo año, el otro extremo va con él.
    expect(p('del 1/12/2025 al 31/1')).toMatchObject({ desde: '2025-12-01', hasta: '2026-01-31' });
    expect(p('del 1/12 al 31/1/2026')).toMatchObject({ desde: '2025-12-01', hasta: '2026-01-31' });
    expect(p('del 30/2 al 3/3')).toBeUndefined();
  });

  it('semestres', () => {
    expect(p('resultado del primer semestre')).toMatchObject({ desde: '2026-01-01', hasta: '2026-06-30', codigo: '2026-1S' });
    expect(p('el segundo semestre')).toMatchObject({ desde: '2026-07-01', hasta: '2026-12-31' });
    expect(p('el segundo semestre', '2026-03-10')).toMatchObject({ desde: '2025-07-01', hasta: '2025-12-31' });
    expect(p('el primer semestre del año pasado')).toMatchObject({ desde: '2025-01-01', hasta: '2025-06-30' });
    expect(p('el 1er semestre de 2024')).toMatchObject({ desde: '2024-01-01', hasta: '2024-06-30' });
    expect(p('este semestre')).toMatchObject({ desde: '2026-07-01', hasta: '2026-12-31', codigo: 'este-semestre' });
    expect(p('el semestre pasado')).toMatchObject({ desde: '2026-01-01', hasta: '2026-06-30', codigo: 'semestre-pasado' });
    expect(resolverCodigoPeriodo('semestre-pasado', '2026-03-10')).toMatchObject({ desde: '2025-07-01', hasta: '2025-12-31' });
    expect(resolverCodigoPeriodo('2026-2S', HOY)).toMatchObject({ desde: '2026-07-01', hasta: '2026-12-31' });
    expect(resolverCodigoPeriodo('2026-3S', HOY)).toBeNull();
  });
});

describe('revisión: terceros', () => {
  const t = (id: string, rol: Tercero['rol'], nombre: string, nif?: string): Tercero => ({
    id,
    rol,
    nombre,
    tokens: rol === 'banco' ? tokensBanco(nombre) : tokensNombre(nombre),
    nif,
  });

  it('una palabra que está entera en el nombre de dos clientes: se pregunta, aunque uno empiece por ella', () => {
    const indice = [t('c2', 'cliente', 'Talleres Martínez SA'), t('c6', 'cliente', 'MARTINEZ HERMANOS SL'), t('p1', 'proveedor', 'Martínez Suministros SL')];
    const r = buscarEnIndice(normalizar('cuanto me debe martinez').base, indice, ['cliente']);
    expect(r?.tipo).toBe('dudas');
    expect(r && r.tipo === 'dudas' ? r.candidatos.map((c) => c.tercero.id).sort() : []).toEqual(['c2', 'c6']);
    // Con el nombre completo, sin dudas.
    expect(buscarEnIndice(normalizar('cuanto me debe martinez hermanos').base, indice, ['cliente'])).toMatchObject({ tipo: 'unico', tercero: { id: 'c6' } });
    // Un solo cliente con esa palabra: solo él (como antes, se confirma con un botón).
    const solo = buscarEnIndice(normalizar('cuanto me debe martinez').base, [indice[0]]);
    expect(solo && solo.tipo === 'dudas' ? solo.candidatos.map((c) => c.tercero.id) : []).toEqual(['c2']);
  });

  it('el nombre del banco cuenta si la pregunta habla del banco', () => {
    const indice = [t('b1', 'banco', 'Banco Sabadell'), t('b2', 'banco', 'BBVA'), t('b3', 'banco', 'Caja Rural'), t('c1', 'cliente', 'Construcciones Pérez SL')];
    expect(buscarEnIndice(normalizar('cuanto tengo en el sabadell').base, indice)).toMatchObject({ tipo: 'unico', tercero: { id: 'b1' } });
    expect(buscarEnIndice(normalizar('saldo del bbva').base, indice)).toMatchObject({ tipo: 'unico', tercero: { id: 'b2' } });
    expect(buscarEnIndice(normalizar('saldo de caja rural').base, indice)).toMatchObject({ tipo: 'unico', tercero: { id: 'b3' } });
  });

  it('un NIF que no es de nadie se dice tal cual', () => {
    const indice = [t('c1', 'cliente', 'Construcciones Pérez SL', 'B11111111')];
    expect(buscarEnIndice(normalizar('B99999999').base, indice)).toEqual({ tipo: 'ninguno', trozo: 'B99999999', parecidos: [] });
    expect(buscarEnIndice(normalizar('cuanto me debe construcciones perez b99999999').base, indice)).toMatchObject({ tipo: 'unico', tercero: { id: 'c1' } });
  });
});
