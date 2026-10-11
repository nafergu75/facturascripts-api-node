// El boton "Descargar fichero AEAT" de la pantalla del 303 tiene que dar el
// fichero OFICIAL (diseno de registro 2026), no un resumen legible; y la
// pantalla tiene que ensenar las mismas casillas que van en ese fichero.
let nif: string | null = 'B12345678';
let compras: Array<{ base: number; cuota: number }> = [];
let filaAnterior: Record<string, unknown> | null = null;
const guardadas = new Map<string, Record<string, unknown>>();
jest.mock('../config/database', () => ({
  prisma: {
    legalConfig: { findUnique: jest.fn(async () => ({ nif, denominacion: 'Ejemplo, S.L.' })) },
    modeloImpuesto: {
      findMany: jest.fn(async () => []),
      // El 303 del 1T (periodo anterior) dejo cuotas a compensar.
      findUnique: jest.fn(async ({ where }: { where: { companyId_codigo_ejercicio_periodo?: { periodo: string } } }) => {
        const p = where.companyId_codigo_ejercicio_periodo?.periodo;
        return p === '1T' ? filaAnterior : guardadas.get(String(p)) ?? null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const fila = { id: `m-${data.periodo}`, ...data };
        guardadas.set(String(data.periodo), fila);
        return fila;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm', estado: 'vigente', ...data })),
    },
  },
}));
jest.mock('../services/facturascripts-client', () => ({ getFsClientForCompany: jest.fn(async () => { throw new Error('sin FS'); }) }));
jest.mock('../services/bancos.service', () => ({
  listarCuentasBancarias: jest.fn(async () => [
    { id: 'cb1', companyId: 'e1', iban: 'ES91 2100 0418 4502 0005 1332', bancoNombre: 'Banco', subcuentaCodigo: '572000', activa: true },
  ]),
}));
jest.mock('../services/tax-documents.service', () => ({
  taxDocumentsService: {
    obtenerLibroIVAEmitidas: jest.fn(async () => ({ facturas: [], totalCuotas: 0, totalBases: 0 })),
    obtenerLibroIVARecibidas: jest.fn(async () => ({ facturas: [], totalCuotas: 0, totalBases: 0 })),
  },
}));
jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn(async () => undefined) }));
jest.mock('../services/impuestosCalculo.service', () => {
  const real = jest.requireActual('../services/impuestosCalculo.service');
  return {
    ...real,
    calcularModelo303: jest.fn(async (_c: string, periodo: { fechaInicio: string }, aCompensar = 0) =>
      real.agregar303(
        [
          { idFactura: '1', tipo: 'venta', cifnif: 'B9', nombreTercero: 'C', fecha: '2026-05-10', operacion: 'interior', lineas: [{ tipoIva: 21, base: 1000, cuota: 210 }] },
          ...compras.map((l, i) => ({ idFactura: `c${i}`, tipo: 'compra', cifnif: 'B8', nombreTercero: 'P', fecha: '2026-05-11', operacion: 'interior', lineas: [{ tipoIva: 21, ...l }] })),
        ],
        periodo,
        aCompensar,
      ),
    ),
  };
});

import { generarTxt303Trimestre } from '../services/impuestosModulo.service';
import { taxModelsService } from '../services/tax-models.service';
import { campoDeCasilla303 } from '../domain/aeat/modelo303-2026';

/** Importe de una casilla leido del fichero (pagina 1 o 3), con el diseno oficial. */
function leerDelFichero(fichero: string, casilla: string): number {
  for (const [pagina, etiqueta] of [['01', '<T30301000>'], ['03', '<T30303000>']] as const) {
    let campo;
    try {
      campo = campoDeCasilla303(pagina, casilla);
    } catch {
      continue;
    }
    const texto = fichero.slice(fichero.indexOf(etiqueta)).substr((campo.pos as number) - 1, campo.lon as number);
    return (texto.startsWith('N') ? -Number(texto.slice(1)) : Number(texto)) / 100;
  }
  throw new Error(`Casilla [${casilla}] no esta en las paginas 1 y 3`);
}

beforeEach(() => {
  nif = 'B12345678';
  compras = [];
  filaAnterior = null;
  guardadas.clear();
});

describe('fichero del 303 desde la pantalla', () => {
  it('es el fichero oficial 2026: cabecera, paginas 1 y 3 y cierre, con el NIF y el 21 % en [07]-[09]', async () => {
    const r = await generarTxt303Trimestre('e1', 2026, 2);
    expect(r.nombre).toBe('303_2026_2T.txt');
    expect(r.contenido.startsWith('<T30302026' + '2T0000><AUX>')).toBe(true);
    expect(r.contenido.endsWith('</T30302026' + '2T0000>')).toBe(true); // sin salto de linea
    expect(r.contenido).toHaveLength(328 + 1581 + 1017 + 18);
    expect(r.contenido).toContain('B12345678');
    expect(r.contenido).toContain('EJEMPLO SL');
    expect(r.contenido).not.toMatch(/MODELO 303 -|borrador/i); // ya no es el resumen legible
    const pag1 = r.contenido.slice(r.contenido.indexOf('<T30301000>'));
    expect(pag1.slice(325, 342)).toBe('00000000000100000'); // [07] base 1.000,00
  });

  it('sin NIF no se genera y dice donde rellenarlo', async () => {
    nif = null;
    await expect(generarTxt303Trimestre('e1', 2026, 2)).rejects.toThrow(/Falta el NIF.*Registro Mercantil/);
  });
});

describe('pantalla del 303 = fichero del 303', () => {
  it('cada casilla de la pantalla tiene el importe que va en el fichero, con su numero y descripcion oficial', async () => {
    compras = [{ base: 200, cuota: 42 }];
    const pantalla = await taxModelsService.generarModelo303('e1', 2026, 2, 'u1');
    const { contenido } = await generarTxt303Trimestre('e1', 2026, 2);
    expect(pantalla.casillas303.length).toBeGreaterThan(80);
    for (const c of pantalla.casillas303) {
      expect({ casilla: c.numero, valor: c.valor }).toEqual({ casilla: c.numero, valor: leerDelFichero(contenido, c.numero) });
    }
    const de = (n: string) => pantalla.casillas303.find((c) => c.numero === n);
    expect(de('07')).toMatchObject({ seccion: 'IVA devengado', concepto: 'Régimen general', columna: 'Base imponible', valor: 1000 });
    expect(de('08')).toMatchObject({ columna: 'Tipo %', valor: 21, unidad: 'porcentaje' });
    expect(de('46')).toMatchObject({ formula: '[27] - [45]', valor: 168 });
    expect(de('14')).toMatchObject({ concepto: 'Modificación bases y cuotas', columna: 'Base imponible' });
    expect(de('110')).toMatchObject({ seccion: 'Resultado', concepto: 'Cuotas a compensar pendientes de periodos anteriores' });
    expect(de('71')).toMatchObject({ seccion: 'Resultado', valor: 168 });
    expect(pantalla.resultado).toBe(168);
    expect(pantalla.tipoDeclaracion).toBe('I');
    expect(pantalla.tiposDeclaracion.map((t) => t.codigo)).toEqual(['I', 'U']);
    // Guarda lo mismo que el modulo Impuestos (y lo que lee el 390 de Modelos fiscales).
    const fila = guardadas.get('2T') as { datos: Record<string, unknown>; casillas: Record<string, unknown> };
    expect(fila.casillas['71_resultado']).toBe(168);
    expect(fila.datos).toMatchObject({ ivaRepercutido: 210, ivaSoportado: 42, resultado: 168, tipoDeclaracion: 'I' });
    expect((fila.datos.casillasOficiales as Record<string, number>)['71']).toBe(168);
  });

  it('las cuotas a compensar salen del 303 anterior ([87] + su resultado negativo) o del importe que se ponga', async () => {
    filaAnterior = { id: 'm1', estado: 'presentado', casillas: {}, datos: { casillasOficiales: { '87': 50, '71': -100 }, tipoDeclaracion: 'C' } };
    const deAntes = await taxModelsService.generarModelo303('e1', 2026, 2);
    expect(deAntes.aCompensar).toMatchObject({ importe: 150, origen: 'periodo-anterior', periodo: '1T de 2026' });
    expect(deAntes.casillas303.find((c) => c.numero === '110')?.valor).toBe(150);
    expect(deAntes.resultado).toBe(60); // 210 - 150

    const manual = await taxModelsService.generarModelo303('e1', 2026, 2, 'u1', { aCompensar: 300 });
    expect(manual.aCompensar).toMatchObject({ importe: 300, origen: 'manual' });
    expect(manual.resultado).toBe(0);
    expect(manual.tipoDeclaracion).toBe('N');
    const { contenido } = await generarTxt303Trimestre('e1', 2026, 2, { aCompensar: 300 });
    expect([leerDelFichero(contenido, '110'), leerDelFichero(contenido, '78'), leerDelFichero(contenido, '87')]).toEqual([300, 210, 90]);
  });

  it('con domiciliacion, el fichero lleva la pagina DID con el IBAN de la cuenta elegida (en pantalla, tapado)', async () => {
    const pantalla = await taxModelsService.generarModelo303('e1', 2026, 2, 'u1', { tipoDeclaracion: 'U' });
    expect(pantalla.cuentas).toEqual([{ id: 'cb1', iban: 'ES91 **** 1332', banco: 'Banco' }]);
    expect(pantalla.cuentaBancariaId).toBe('cb1');
    const { contenido } = await generarTxt303Trimestre('e1', 2026, 2, { tipoDeclaracion: 'U', cuentaBancariaId: 'cb1' });
    const did = contenido.slice(contenido.indexOf('<T303DID00>'));
    expect(did.slice(22, 46)).toBe('ES9121000418450200051332');
    await expect(generarTxt303Trimestre('e1', 2026, 2, { tipoDeclaracion: 'D' })).rejects.toThrow(/puede ser I \(ingreso\) o U/);
  });
});
