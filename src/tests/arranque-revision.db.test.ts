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
import { estadoArranque, subirYAnalizar } from '../services/arranque/cargas.service';
import { saldosComparativosImportados } from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { analizarPlanSinEscribir } from '../services/puestaEnMarcha/planAnterior';
import { createHash } from 'crypto';
import { AJUSTES_A, anchoFijo, ficherosEmpresaA, ficherosEmpresaB, filasCartera, filasDiario, filasSumasYSaldos, libro, NIF, pdf, PLAN_A, type AsientoPrueba } from './fixtures/arranque/generar';
import { idHoja } from '../services/arranque/datos';
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

describe('la longitud de las subcuentas la fija el plan', () => {
  it('con un plan de 8 digitos y una cartera de 10, manda el plan y el error nombra la cartera', async () => {
    const E = `arr-rev-long-${SUFIJO}`;
    await empresaDePrueba(E);
    const b = ficherosEmpresaB();
    const cartera10 = {
      nombre: 'cartera_10.xlsx',
      contenido: libro([
        [
          'Cartera',
          filasCartera([
            { subcuenta: '4300000001', nombre: 'Cliente Gamma SL', nif: NIF.gamma, documento: 'B-77', fecha: '2026-11-30', vencimiento: '2027-01-30', importe: 5000, pendiente: 5000 },
            { subcuenta: '4000000001', nombre: 'Proveedor Delta SL', nif: NIF.delta, documento: 'D-1', fecha: '2026-12-10', vencimiento: '2027-02-10', importe: 1500, pendiente: 1500 },
            { subcuenta: '4000000002', nombre: 'Proveedor Épsilon SL', nif: NIF.delta, documento: 'E-1', fecha: '2026-12-10', vencimiento: '2027-02-10', importe: 100, pendiente: 100 },
          ]),
        ],
      ]),
    };
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [b.plan, b.sumasSaldos, b.pyg, cartera10], undefined, TODOS);
    expect(r.vista.plan.longitud.delPlan).toBe(8);
    const punto = r.vista.comprobaciones.puntos.find((p) => p.clave === 'plan:longitud');
    expect(punto?.nivel).toBe('ERROR');
    expect(punto?.texto).toBe('En cartera_10.xlsx hay 3 subcuentas de clientes o proveedores de 10 dígitos, y el plan usa 8. Pide a la gestoría todos los listados al mismo nivel que el plan.');
    // Las del plan no salen como incoherentes.
    expect(punto?.detalle).not.toContain('43000001');
  });
});

describe('dos ficheros del mismo tipo', () => {
  it('el error dice de qué tipo y cuáles son, y cada tarjeta lo avisa', async () => {
    const E = `arr-rev-rep-${SUFIJO}`;
    await empresaDePrueba(E);
    const b = ficherosEmpresaB();
    const otro = { nombre: 'otro_sys.xlsx', contenido: libro([['SyS', filasSumasYSaldos([{ codigo: '57200001', nombre: 'Banco', debe: 10, haber: 0, saldo: 10 }, { codigo: '10000000', nombre: 'Capital', debe: 0, haber: 10, saldo: -10 }], 'Sumas y saldos')]]) };
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [b.plan, b.sumasSaldos, otro], undefined, TODOS);
    const punto = r.vista.comprobaciones.puntos.find((p) => p.clave === 'repetido:SUMAS_Y_SALDOS');
    expect(punto?.texto).toBe(
      'Hay dos ficheros de sumas y saldos distintos (b_balance_sumas_saldos.xlsx › SyS y otro_sys.xlsx › SyS): quita uno o marca el que no vale con «No usar esta hoja».',
    );
    const tarjetas = r.vista.hojas.filter((h) => h.tipo === 'SUMAS_Y_SALDOS');
    expect(tarjetas).toHaveLength(2);
    for (const t of tarjetas) expect(t.avisos.some((a) => a.startsWith('Hay otro fichero de sumas y saldos'))).toBe(true);
  });
});

describe('el diálogo de confirmación dice lo que cambia en 2026', () => {
  it('nombra los bienes, que 2026 queda de solo lectura y los asientos de la app que se retiran', async () => {
    const E = `arr-rev-conf-${SUFIJO}`;
    await empresaDePrueba(E);
    // Un asiento de 2026 hecho en la app: la carga lo retira.
    await prisma.journalEntry.create({
      data: {
        companyId: E,
        fecha: new Date('2026-05-05T00:00:00Z'),
        numeroAsiento: 'AJUSTE-00001',
        descripcion: 'Asiento hecho en la app',
        origen: 'AJUSTE_MANUAL',
        estado: 'POSTED',
        lineas: { create: [{ companyId: E, accountCode: '5720000001', accountName: 'Banco', debe: 10 }, { companyId: E, accountCode: '7000000000', accountName: 'Ventas', haber: 10 }] },
      },
    });
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, Object.values(ficherosEmpresaA()), undefined, TODOS);
    expect(r.vista.confirmacion).toContain('y 2 bienes de inmovilizado.');
    expect(r.vista.confirmacion).toContain('2026 quedará como «lo llevó la gestoría»: se podrá consultar, pero no apuntar nada con fecha de 2026.');
    expect(r.vista.confirmacion).toContain('1 asiento de 2026 apuntado en la app se retira (no se borra).');
  });
});

describe('la carga vigente separa los ficheros usados de los que no', () => {
  it('un PDF y un fichero de ancho fijo marcados «No usar» salen como no usados', async () => {
    const E = `arr-rev-nous-${SUFIJO}`;
    await empresaDePrueba(E);
    const fs = [...Object.values(ficherosEmpresaA()), pdf(), anchoFijo()];
    const ajustes = { ...AJUSTES_A, hojas: Object.fromEntries([pdf(), anchoFijo()].map((f) => [idHoja(createHash('sha256').update(f.contenido).digest('hex'), f.nombre), { excluida: true }])) };
    await traerCarga(E, fs, ajustes);
    const estado = await estadoArranque(E, 2027);
    expect(estado.vigente?.ficheros).toHaveLength(9);
    expect([...(estado.vigente?.ficherosNoUsados ?? [])].sort()).toEqual(['balance.pdf', 'export.txt']);
    // Un fichero que no se puede leer no trae avisos de lectura, solo su error.
    const r = await subirYAnalizar(`${E}`, 2027, USUARIO_PRUEBA, [anchoFijo()], undefined, TODOS);
    expect(r.vista.hojas[0].avisos).toEqual([]);
  });
});
