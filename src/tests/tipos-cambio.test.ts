// Tipos de cambio del BCE (axios y BD simulados): fuentes, cache, alternativa,
// tipo manual y que nunca se consulte la red dentro de una transaccion.
const cache = new Map<string, { moneda: string; fecha: string; unidadesPorEur: number }>();
jest.mock('../config/database', () => ({
  prisma: {
    tipoCambioBce: {
      findUnique: jest.fn(async ({ where }: { where: { moneda_fecha: { moneda: string; fecha: string } } }) => {
        return cache.get(`${where.moneda_fecha.moneda}|${where.moneda_fecha.fecha}`) ?? null;
      }),
      findFirst: jest.fn(async ({ where }: { where: { moneda: string; fecha: { lte: string; gte: string } } }) => {
        const filas = [...cache.values()]
          .filter((f) => f.moneda === where.moneda && f.fecha <= where.fecha.lte && f.fecha >= where.fecha.gte)
          .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
        return filas[0] ?? null;
      }),
      upsert: jest.fn(async ({ create }: { create: { moneda: string; fecha: string; unidadesPorEur: number } }) => {
        cache.set(`${create.moneda}|${create.fecha}`, create);
        return create;
      }),
    },
  },
}));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import axios from 'axios';
import {
  limpiarMemoTiposCambio,
  marcarTransaccion,
  obtenerUnidadesPorEur,
  parsearCsvBce,
  resolverTipoCambio,
  urlBce,
  urlFrankfurter,
} from '../services/tiposCambio.service';

const get = (axios as unknown as { get: jest.Mock }).get;
const AHORA = new Date('2026-10-07T10:00:00Z');

const CABECERA =
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT';
const csv = (moneda: string, fecha: string, valor: string) =>
  `${CABECERA}\r\nEXR.D.${moneda}.EUR.SP00.A,D,${moneda},EUR,SP00,A,${fecha},${valor},A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",${moneda},0\r\n`;

beforeEach(() => {
  cache.clear();
  limpiarMemoTiposCambio();
  get.mockReset();
  // Los avisos de "no responde" son esperados en estas pruebas.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('lectura del CSV del BCE', () => {
  it('por cabecera, con comillas y comas dentro de un campo', () => {
    expect(parsearCsvBce(csv('USD', '2026-09-18', '1.146'))).toEqual({ fecha: '2026-09-18', valor: 1.146 });
  });
  it('200 vacio o solo la cabecera = sin dato', () => {
    expect(parsearCsvBce('')).toBeNull();
    expect(parsearCsvBce(`${CABECERA}\n`)).toBeNull();
    expect(parsearCsvBce('no,es,el,csv\n1,2,3,4')).toBeNull();
  });
  it('URL: ultima observacion <= fecha (nunca la fecha exacta) y Frankfurter con providers=ECB', () => {
    expect(urlBce('USD', '2026-09-18')).toBe(
      'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?endPeriod=2026-09-18&lastNObservations=1&format=csvdata',
    );
    expect(urlFrankfurter('USD', '2026-09-18')).toContain('providers=ECB');
    expect(urlFrankfurter('USD', '2026-09-18')).toContain('base=EUR&quotes=USD');
  });
});

describe('obtenerUnidadesPorEur', () => {
  it('pide al BCE el ultimo dia habil <= devengo, con timeout de 4 s, y lo guarda en la cache por su fecha real', async () => {
    get.mockResolvedValueOnce({ data: csv('USD', '2026-09-18', '1.146') });
    const r = await obtenerUnidadesPorEur('USD', '2026-09-20', { ahora: AHORA });
    expect(r).toMatchObject({ fecha: '2026-09-18', unidadesPorEur: 1.146, origen: 'ECB_API', vieja: false });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(urlBce('USD', '2026-09-18'));
    expect(get.mock.calls[0][1]).toMatchObject({ timeout: 4000 });
    expect(cache.get('USD|2026-09-18')).toMatchObject({ unidadesPorEur: 1.146 });
    // Segunda vez: memoria del proceso, sin red.
    await obtenerUnidadesPorEur('USD', '2026-09-20', { ahora: AHORA });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('con la cache exacta no llama a la red', async () => {
    cache.set('USD|2026-09-18', { moneda: 'USD', fecha: '2026-09-18', unidadesPorEur: 1.146 });
    const r = await obtenerUnidadesPorEur('USD', '2026-09-19', { ahora: AHORA });
    expect(r?.unidadesPorEur).toBe(1.146);
    expect(get).not.toHaveBeenCalled();
  });

  it('si el BCE falla, Frankfurter (providers=ECB) con la fecha real que devuelve', async () => {
    get.mockRejectedValueOnce(new Error('timeout of 4000ms exceeded'));
    get.mockResolvedValueOnce({ data: [{ date: '2026-09-18', base: 'EUR', quote: 'USD', rate: 1.146 }] });
    const r = await obtenerUnidadesPorEur('USD', '2026-09-18', { ahora: AHORA });
    expect(r).toMatchObject({ fecha: '2026-09-18', unidadesPorEur: 1.146, origen: 'FRANKFURTER_ECB' });
    expect(get.mock.calls[1][0]).toContain('providers=ECB');
  });

  it('200 vacio del BCE cuenta como sin dato', async () => {
    get.mockResolvedValueOnce({ data: '' });
    get.mockResolvedValueOnce({ data: [] });
    expect(await obtenerUnidadesPorEur('USD', '2026-09-18', { ahora: AHORA })).toBeNull();
  });

  it('sin fuentes: emitir no usa una cache vieja; un borrador si (hasta 7 dias), como provisional', async () => {
    cache.set('USD|2026-09-14', { moneda: 'USD', fecha: '2026-09-14', unidadesPorEur: 1.15 });
    get.mockRejectedValue(new Error('caido'));
    expect(await obtenerUnidadesPorEur('USD', '2026-09-18', { ahora: AHORA })).toBeNull();
    const vieja = await obtenerUnidadesPorEur('USD', '2026-09-18', { ahora: AHORA, permitirVieja: true });
    expect(vieja).toMatchObject({ fecha: '2026-09-14', vieja: true });
    // Mas de 7 dias: nada.
    expect(await obtenerUnidadesPorEur('USD', '2026-09-30', { ahora: AHORA, permitirVieja: true })).toBeNull();
  });

  it('nunca consulta la red dentro de una transaccion', async () => {
    get.mockResolvedValue({ data: csv('USD', '2026-09-18', '1.146') });
    await expect(marcarTransaccion(() => obtenerUnidadesPorEur('USD', '2026-09-18', { ahora: AHORA }))).rejects.toThrow(/transacción/);
    expect(get).not.toHaveBeenCalled();
    // Fuera de la transaccion, si.
    await expect(obtenerUnidadesPorEur('USD', '2026-09-18', { ahora: AHORA })).resolves.toMatchObject({ unidadesPorEur: 1.146 });
  });
});

describe('resolverTipoCambio', () => {
  it('misma moneda: PAR, sin red; un manual distinto de 1 es un error', async () => {
    await expect(resolverTipoCambio({ monedaCuenta: 'EUR', moneda: 'EUR', devengo: '2026-09-18', definitivo: true })).resolves.toEqual({
      tipoCambio: 1,
      fechaTipoCambio: null,
      fuente: 'PAR',
      provisional: false,
    });
    await expect(
      resolverTipoCambio({ monedaCuenta: 'EUR', moneda: 'EUR', devengo: '2026-09-18', manual: 1.1, definitivo: true }),
    ).rejects.toThrow(/es 1/);
    expect(get).not.toHaveBeenCalled();
  });

  it('BCE del devengo', async () => {
    get.mockResolvedValueOnce({ data: csv('USD', '2026-09-21', '1.149') });
    const t = await resolverTipoCambio({ monedaCuenta: 'EUR', moneda: 'USD', devengo: '2026-09-21', definitivo: true, ahora: AHORA });
    expect(t).toEqual({ tipoCambio: 1.149, fechaTipoCambio: '2026-09-21', fuente: 'BCE', provisional: false });
  });

  it('sin fuentes al emitir: PENDIENTE y el mensaje para indicarlo a mano', async () => {
    get.mockRejectedValue(new Error('caido'));
    const t = await resolverTipoCambio({ monedaCuenta: 'EUR', moneda: 'USD', devengo: '2026-09-21', definitivo: true, ahora: AHORA });
    expect(t.fuente).toBe('PENDIENTE');
    expect(t.tipoCambio).toBeNull();
    expect(t.aviso).toBe('No se ha podido obtener el tipo del BCE para USD a 21/09/2026: indícalo a mano.');
  });

  it('manual: invertido o muy lejos del BCE -> 400; desviado -> aviso; sin BCE, con la referencia aproximada', async () => {
    get.mockResolvedValue({ data: csv('USD', '2026-09-21', '1.149') });
    const base = { monedaCuenta: 'EUR', moneda: 'USD', devengo: '2026-09-21', definitivo: true, ahora: AHORA };
    await expect(resolverTipoCambio({ ...base, manual: 0.87 })).rejects.toThrow(/invertido/);
    await expect(resolverTipoCambio({ ...base, manual: 3 })).rejects.toThrow(/lejos/);
    const desviado = await resolverTipoCambio({ ...base, manual: '1,17' });
    expect(desviado).toMatchObject({ tipoCambio: 1.17, fuente: 'MANUAL', fechaTipoCambio: '2026-09-21' });
    expect(desviado.aviso).toMatch(/0,5 %/);

    limpiarMemoTiposCambio();
    cache.clear();
    get.mockReset();
    get.mockRejectedValue(new Error('caido'));
    // Sin BCE ni cache: el invertido o absurdo no pasa; uno razonable, con aviso.
    await expect(resolverTipoCambio({ ...base, manual: 0.87 })).rejects.toThrow(/invertido/);
    await expect(resolverTipoCambio({ ...base, manual: '0,0001' })).rejects.toThrow(/lejos/);
    const sinBce = await resolverTipoCambio({ ...base, manual: 1.15 });
    expect(sinBce).toMatchObject({ fuente: 'MANUAL', tipoCambio: 1.15 });
    expect(sinBce.aviso).toMatch(/No se ha podido comprobar/);

    // Sin BCE del dia pero con un tipo guardado de hace meses: se compara con el.
    limpiarMemoTiposCambio();
    cache.set('USD|2026-03-02', { moneda: 'USD', fecha: '2026-03-02', unidadesPorEur: 1.6 });
    await expect(resolverTipoCambio({ ...base, manual: 1.12 })).resolves.toMatchObject({ fuente: 'MANUAL', tipoCambio: 1.12 });
    await expect(resolverTipoCambio({ ...base, manual: 0.625 })).rejects.toThrow(/invertido.*1,6000/);
  });

  it('empresa en USD: EUR con el inverso y HKD con el cruzado del mismo dia', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes('D.USD.')) return { data: csv('USD', '2026-09-21', '1.149') };
      if (url.includes('D.HKD.')) return { data: csv('HKD', '2026-09-21', '8.9415') };
      throw new Error('no');
    });
    const eur = await resolverTipoCambio({ monedaCuenta: 'USD', moneda: 'EUR', devengo: '2026-09-21', definitivo: true, ahora: AHORA });
    expect(eur).toMatchObject({ tipoCambio: 0.87032202, fuente: 'BCE', fechaTipoCambio: '2026-09-21' });
    const hkd = await resolverTipoCambio({ monedaCuenta: 'USD', moneda: 'HKD', devengo: '2026-09-21', definitivo: true, ahora: AHORA });
    expect(hkd.tipoCambio).toBe(Math.round((8.9415 / 1.149) * 1e8) / 1e8);
    const usd = await resolverTipoCambio({ monedaCuenta: 'USD', moneda: 'USD', devengo: '2026-09-21', definitivo: true, ahora: AHORA });
    expect(usd.fuente).toBe('PAR');
  });
});
