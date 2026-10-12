/**
 * Arreglos de la revision de «Traer la contabilidad de 2026» que necesitan la
 * base de datos: el comparativo con la PyG oficial (sumas y saldos
 * regularizado sin diario), la apertura que sale solo del diario con grupos 8
 * y 9...
 *
 * Necesita MySQL.
 */
import { describe, it, expect } from '@jest/globals';
import { prisma } from '../config/database';
import { subirYAnalizar } from '../services/arranque/cargas.service';
import { saldosComparativosImportados } from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { analizarPlanSinEscribir } from '../services/puestaEnMarcha/planAnterior';
import { ficherosEmpresaB, filasDiario, filasSumasYSaldos, libro, PLAN_A, type AsientoPrueba } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, TODOS, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const SUFIJO = Date.now();

describe('comparativo de 2026 con el sumas y saldos regularizado y la PyG oficial', () => {
  it('los gastos e ingresos de la PyG llegan al comparativo y la 129 no se cuenta dos veces', async () => {
    const E = `arr-rev-pyg-${SUFIJO}`;
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaB()));
    const fila = await prisma.priorYearData.findFirst({ where: { companyId: E, ejercicio: 2026 } });
    expect(Number(fila!.ingresos)).toBe(8000);
    expect(Number(fila!.gasto)).toBe(5000);
    expect(Number(fila!.beneficio)).toBe(3000);
    const saldos = await saldosComparativosImportados(E, 2026);
    expect(Object.fromEntries(saldos!.pyg)).toEqual({ '629': 5000, '700': -8000 });
    expect([...saldos!.balance.keys()].some((k) => k.startsWith('129'))).toBe(false);
  });

  it('sin las partidas de la PyG, se avisa de que falta para la columna de 2026', async () => {
    const E = `arr-rev-pyg2-${SUFIJO}`;
    await empresaDePrueba(E);
    const b = ficherosEmpresaB();
    // Le falta la partida 7 (Otros gastos de explotación): sus partidas no suman el resultado.
    const pygSoloResultado = {
      nombre: 'b_pyg.xlsx',
      contenido: libro([
        [
          'PyG',
          [
            ['Cuenta de pérdidas y ganancias 2026'],
            ['', 'Ejercicio 2026'],
            ['1. Importe neto de la cifra de negocios', 8000],
            ['a) Prestaciones de servicios', 8000],
            ['4. Aprovisionamientos', 0],
            ['6. Gastos de personal', 0],
            ['8. Amortización del inmovilizado', 0],
            ['13. Otros resultados', 0],
            ['A.1) RESULTADO DE EXPLOTACIÓN', 3000],
            ['A.3) RESULTADO ANTES DE IMPUESTOS', 3000],
            ['A.4) RESULTADO DEL EJERCICIO', 3000],
          ],
        ],
      ]),
    };
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [b.plan, b.sumasSaldos, b.cartera, pygSoloResultado], undefined, TODOS);
    const punto = r.vista.comprobaciones.puntos.find((p) => p.clave === 'falta:PYG-detalle');
    expect(punto?.nivel).toBe('FALTA');
    expect(punto?.texto).toMatch(/antes de regularizar o el libro diario/);
  });
});

describe('apertura solo con el diario, con grupos 8 y 9', () => {
  it('se puede confirmar y la fase de la apertura no falla', async () => {
    const E = `arr-rev-89-${SUFIJO}`;
    await empresaDePrueba(E);
    const diario: AsientoPrueba[] = [
      { numero: 1, fecha: '2026-01-01', concepto: 'Asiento de apertura', lineas: [['5720000001', 50000, 0], ['1000000000', 0, 50000]] },
      { numero: 2, fecha: '2026-02-01', concepto: 'Cobro subvención de capital', lineas: [['5720000001', 5000, 0], ['9400000000', 0, 5000]] },
      { numero: 3, fecha: '2026-03-01', concepto: 'Comisión apertura póliza crédito', lineas: [['6260000000', 150, 0], ['5720000001', 0, 150]] },
      { numero: 4, fecha: '2026-12-31', concepto: 'Imputación subvención', lineas: [['8400000000', 1000, 0], ['7460000000', 0, 1000]] },
    ];
    const fichero = { nombre: 'diario.xlsx', contenido: libro([['Diario', filasDiario(diario, PLAN_A)]]) };
    const { r } = await traerCarga(E, [fichero]);
    expect(r.vista.puedeConfirmar).toBe(true);
    const apertura = await prisma.journalEntry.findFirst({ where: { companyId: E, origen: 'APERTURA', estado: 'POSTED' }, include: { lineas: true } });
    const lineas = apertura!.lineas.map((l) => [l.accountCode, Number(l.debe), Number(l.haber)]).sort();
    expect(lineas).toEqual(
      [
        ['1000000000', 0, 50000],
        ['1290000000', 0, 850],
        ['1300000000', 0, 4000],
        ['5720000001', 54850, 0],
      ].sort(),
    );
    // La comision no es la apertura: el historico la guarda como un asiento normal.
    const comision = await prisma.journalEntry.findFirst({ where: { companyId: E, descripcion: { contains: 'Comisión' } } });
    expect(comision?.origen).toBe('HISTORICO');
    const cuenta130 = await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '1300000000' } });
    expect(cuenta130?.parentCodigo).toBe('130');
  });
});

describe('NIF con la letra o el digito de control mal', () => {
  it('no se da de alta la ficha: queda pendiente con el motivo; los extranjeros se aceptan por la forma', async () => {
    const E = `arr-rev-nif-${SUFIJO}`;
    await empresaDePrueba(E);
    const vista = await analizarPlanSinEscribir(
      E,
      [
        { codigo: '43000001', nombre: 'Cliente NIF malo SL', nif: 'B12345678' },
        { codigo: '43000002', nombre: 'Cliente NIF bueno SL', nif: 'B12345674' },
        { codigo: '43000003', nombre: 'Cliente DNI malo', nif: '12345678A' },
        { codigo: '43000004', nombre: 'Client France SARL', nif: 'FR12345678901' },
      ],
      [],
      TODOS,
    );
    const de = new Map(vista.terceros.map((t) => [t.codigo, t]));
    expect(de.get('43000001')).toMatchObject({ accion: 'pendiente', nif: null });
    expect(de.get('43000001')!.motivo).toMatch(/B12345678.*no es válido \(letra o dígito de control\): corrígelo o enlázala a mano/);
    expect(de.get('43000002')).toMatchObject({ accion: 'crear', nif: 'B12345674' });
    expect(de.get('43000003')).toMatchObject({ accion: 'pendiente' });
    expect(de.get('43000004')).toMatchObject({ accion: 'crear', nif: 'FR12345678901' });
  });
});

describe('bienes que no se amortizan y la 28x de la gestoria', () => {
  it('el terreno no crea cuentas de amortizacion; la maquinaria usa la unica 281 con saldo', async () => {
    const E = `arr-rev-inm-${SUFIJO}`;
    await empresaDePrueba(E);
    const saldos = [
      { codigo: '1000000000', nombre: 'Capital', saldo: -150000 },
      { codigo: '2100000000', nombre: 'Terreno', saldo: 50000 },
      { codigo: '2130000000', nombre: 'Maquinaria', saldo: 100000 },
      { codigo: '2811000000', nombre: 'A.A. inmovilizado material', saldo: -10000 },
      { codigo: '5720000001', nombre: 'Banco', saldo: 10000 },
    ];
    const sys = { nombre: 'sys.xlsx', contenido: libro([['SyS', filasSumasYSaldos(saldos.map((x) => ({ ...x, debe: Math.max(x.saldo, 0), haber: Math.max(-x.saldo, 0) })), 'Sumas y saldos')]]) };
    const inm = {
      nombre: 'inmovilizado.xlsx',
      contenido: libro([
        [
          'Inmovilizado',
          [
            ['Fichas de inmovilizado'],
            ['Descripción', 'Cuenta', 'Fecha alta', 'Coste', 'Amort. acumulada', 'Coeficiente'],
            ['Solar polígono', '2100000000', '01/01/2020', 50000, 0, 0],
            ['Torno', '2130000000', '01/01/2022', 100000, 10000, 10],
          ],
        ],
      ]),
    };
    const { r } = await traerCarga(E, [sys, inm]);
    expect(r.vista.comprobaciones.puntos.map((p) => p.clave)).not.toContain('inmovilizado:cuadre');
    const nuevas = r.vista.plan.nuevasMuestra.map((c) => c.codigo);
    expect(nuevas).not.toContain('2810000000');
    expect(nuevas).not.toContain('2813000000');
    const activos = await prisma.activoFijo.findMany({ where: { companyId: E }, orderBy: { descripcion: 'asc' } });
    expect(activos.map((a) => [a.descripcion, a.subcuentaAmortAcum, a.subcuentaDotacion, Number(a.coeficiente)])).toEqual([
      ['Solar polígono', '', '', 0],
      ['Torno', '2811000000', '6810000000', 10],
    ]);
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: { in: ['2810000000', '2813000000', '6800000000'] } } })).toBe(0);
  });
});
