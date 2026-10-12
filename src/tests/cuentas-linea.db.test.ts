/**
 * Cuenta de gasto o de ingreso por LINEA (R2): listado de cuentas elegibles,
 * subcuenta nueva con el siguiente codigo, permisos por tipo, y el asiento de
 * ventas y gastos con una linea por cuenta (alta, rectificativa, edicion del
 * borrador, duplicado y lector).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { controlCif } from '../utils/nif';
import { clientesService } from '../services/clientes.service';
import { proveedoresService } from '../services/proveedores.service';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { anularGasto, editarGasto, registrarGasto } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { crearSubcuentaLinea, listarCuentasLinea, proponerSubcuenta, siguienteCodigoBajo } from '../services/cuentasLinea.service';
import cuentasLineaRoutes from '../routes/cuentasLinea.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const SUFIJO = Date.now();
const E = `ctas-linea-${SUFIJO}`;
const motor = new AccountingEngineController();
let n = 0;

function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

const porCuenta = (lineas: Array<{ accountCode: string; debe: number; haber: number }>) =>
  Object.fromEntries(lineas.map((l) => [l.accountCode, [l.debe, l.haber]]));
const nombreDe = (lineas: Array<{ accountCode: string; accountName: string }>, codigo: string) => lineas.find((l) => l.accountCode === codigo)?.accountName;
const asiento = (id: string) => prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lineas: true } });

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Cuentas Linea SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Cuentas Linea SL', nif: 'B10000000' } });
  await asegurarPlanContableEmpresa(E);
});

describe('siguiente codigo bajo una cuenta madre (puro)', () => {
  it('el mayor + 1, sin rellenar huecos y saltando el 0', () => {
    expect(siguienteCodigoBajo('628', [{ codigo: '628' }, { codigo: '6280001', parentCodigo: '628' }, { codigo: '6280002', parentCodigo: '628' }], 7)).toBe('6280003');
    expect(siguienteCodigoBajo('628', [{ codigo: '6280005', parentCodigo: '628' }, { codigo: '6280001', parentCodigo: '628' }], 7)).toBe('6280006');
    expect(siguienteCodigoBajo('628', [{ codigo: '628' }], 8)).toBe('62800001');
  });

  it('no cuentan las de otra longitud ni las de otra madre mas larga', () => {
    const plan = [
      { codigo: '62800009', parentCodigo: '628' },
      { codigo: '62810004', parentCodigo: '6281' },
      { codigo: '6280099', parentCodigo: '628' },
    ];
    expect(siguienteCodigoBajo('628', plan, 8)).toBe('62800010');
  });

  it('agotado o madre demasiado larga: 400', () => {
    expect(() => siguienteCodigoBajo('6281', [{ codigo: '62819', parentCodigo: '6281' }], 5)).toThrow(/No quedan subcuentas/);
    expect(() => siguienteCodigoBajo('6280001', [], 7)).toThrow(/ya tiene 7 dígitos/);
  });
});

describe('cuentas elegibles y subcuenta nueva', () => {
  it('gastos: grupo 6 de 3 o mas digitos; ventas: 70x; servicios: 705', async () => {
    const g = await listarCuentasLinea(E, 'gasto');
    expect(g.porDefecto).toBe('600');
    expect(g.longitud).toBe(8);
    expect(g.cuentas.length).toBeGreaterThan(5);
    expect(g.cuentas.every((c) => c.codigo.startsWith('6') && c.codigo.length >= 3)).toBe(true);
    const v = await listarCuentasLinea(E, 'venta');
    expect(v.cuentas.every((c) => c.codigo.startsWith('70'))).toBe(true);
    expect(v.cuentas.map((c) => c.codigo)).toEqual(expect.arrayContaining(['700', '705']));
    const s = await listarCuentasLinea(E, 'servicio');
    expect(s.porDefecto).toBe('705');
    expect(s.cuentas.map((c) => c.codigo)).toEqual(['705']);
  });

  it('las cuentas de uso contable (608, 640, 68x, 708...) no salen en la lista de las lineas', async () => {
    const g = await listarCuentasLinea(E, 'gasto');
    const codigos = g.cuentas.map((c) => c.codigo);
    for (const c of ['606', '608', '609', '610', '630', '640', '642', '681', '694']) expect(codigos).not.toContain(c);
    expect(codigos).toEqual(expect.arrayContaining(['600', '621', '628', '631', '649']));
    expect(g.otras).toEqual([]);
    const conContabilidad = await listarCuentasLinea(E, 'gasto', {}, { verUsoContable: true });
    expect(conContabilidad.otras.map((c) => c.codigo)).toEqual(expect.arrayContaining(['608', '640', '681']));
    expect(conContabilidad.cuentas).toEqual(g.cuentas);
    const v = await listarCuentasLinea(E, 'venta');
    for (const c of ['706', '708', '709']) expect(v.cuentas.map((x) => x.codigo)).not.toContain(c);
  });

  it('propone y crea la siguiente subcuenta con la longitud de la empresa', async () => {
    expect(await proponerSubcuenta(E, 'gasto', '628')).toMatchObject({ madre: '628', codigo: '62800001', longitud: 8 });
    const a = await crearSubcuentaLinea(E, { tipo: 'gasto', madre: '628', nombre: 'Luz oficina' });
    expect(a).toMatchObject({ codigo: '62800001', nombre: 'Luz oficina', madre: '628' });
    const b = await crearSubcuentaLinea(E, { tipo: 'gasto', madre: '628', nombre: 'Agua oficina' });
    expect(b.codigo).toBe('62800002');
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '62800002' } })).toMatchObject({
      parentCodigo: '628',
      grupo: 6,
      activo: true,
      esPersonalizadaEmpresa: true,
    });
    // Queda para las siguientes facturas, y se encuentra por el nombre.
    expect((await listarCuentasLinea(E, 'gasto', { q: 'luz' })).cuentas.map((c) => c.codigo)).toEqual(['62800001']);
    expect((await listarCuentasLinea(E, 'gasto', { madre: '628' })).cuentas.map((c) => c.codigo)).toEqual(['628', '62800001', '62800002']);
  });

  it('dos altas a la vez: codigos distintos', async () => {
    const [x, y] = await Promise.all([
      crearSubcuentaLinea(E, { tipo: 'gasto', madre: '629', nombre: 'Uno' }),
      crearSubcuentaLinea(E, { tipo: 'gasto', madre: '629', nombre: 'Dos' }),
    ]);
    expect(new Set([x.codigo, y.codigo])).toEqual(new Set(['62900001', '62900002']));
  });

  it('codigo indicado: valido y libre; si ya existe, 409', async () => {
    expect((await crearSubcuentaLinea(E, { tipo: 'servicio', madre: '705', nombre: 'Consultoría', codigo: '70500010' })).codigo).toBe('70500010');
    await expect(crearSubcuentaLinea(E, { tipo: 'servicio', madre: '705', nombre: 'Otra', codigo: '70500010' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(crearSubcuentaLinea(E, { tipo: 'venta', madre: '700', nombre: 'X', codigo: '7010001' })).rejects.toMatchObject({ statusCode: 400 });
    // La siguiente automatica salta la indicada.
    expect((await proponerSubcuenta(E, 'servicio', '705')).codigo).toBe('70500011');
  });

  it('madre de otro tipo, inexistente, sin nombre: 400', async () => {
    await expect(crearSubcuentaLinea(E, { tipo: 'gasto', madre: '700', nombre: 'X' })).rejects.toMatchObject({ statusCode: 400, details: { campo: 'madre' } });
    await expect(crearSubcuentaLinea(E, { tipo: 'venta', madre: '70999', nombre: 'X' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(crearSubcuentaLinea(E, { tipo: 'gasto', madre: '628', nombre: '  ' })).rejects.toMatchObject({ statusCode: 400, details: { campo: 'nombre' } });
    await expect(crearSubcuentaLinea(E, { tipo: 'nomina', madre: '640', nombre: 'X' })).rejects.toMatchObject({ statusCode: 400, details: { campo: 'tipo' } });
  });
});

describe('permisos de la ruta', () => {
  function app(rol: string, permisos: string[]) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: `u-${rol}`, email: `${rol}@test.local`, roles: [rol], companies: [E], rolesPorEmpresa: { [E]: [rol] }, permisosPorEmpresa: { [E]: permisos } } as never;
      req.companyId = E;
      next();
    });
    a.use('/cuentas-linea', cuentasLineaRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('ventas: ve y crea cuentas de ventas, pero no de gastos', async () => {
    const v = app('ventas', ['ventas:read', 'ventas:write']);
    expect((await request(v).get('/cuentas-linea?tipo=venta')).status).toBe(200);
    expect((await request(v).get('/cuentas-linea?tipo=gasto')).status).toBe(403);
    const ok = await request(v).post('/cuentas-linea').send({ tipo: 'venta', madre: '700', nombre: 'Ventas tienda' });
    expect(ok.status).toBe(201);
    expect(ok.body.data ?? ok.body).toMatchObject({ codigo: '70000001' });
    expect((await request(v).post('/cuentas-linea').send({ tipo: 'gasto', madre: '628', nombre: 'X' })).status).toBe(403);
  });

  it('compras con solo lectura: ve las de gastos pero no crea', async () => {
    const c = app('compras', ['compras:read']);
    expect((await request(c).get('/cuentas-linea/siguiente?tipo=gasto&madre=628')).status).toBe(200);
    expect((await request(c).post('/cuentas-linea').send({ tipo: 'gasto', madre: '628', nombre: 'X' })).status).toBe(403);
  });

  it('las de uso contable aparte solo para contabilidad:write y el administrador', async () => {
    const otras = async (rol: string, permisos: string[]) => (await request(app(rol, permisos)).get('/cuentas-linea?tipo=gasto')).body.data.otras.map((c: { codigo: string }) => c.codigo);
    expect(await otras('compras-uso', ['compras:write'])).toEqual([]);
    expect(await otras('contable-uso', ['contabilidad:write'])).toEqual(expect.arrayContaining(['608', '640']));
    expect(await otras('admin-uso', ['*'])).toEqual(expect.arrayContaining(['608', '640']));
  });

  it('sin Contabilidad «Modificar», la cuenta de uso contable que ya lleva una linea se ve con su nombre, sin la lista', async () => {
    const c = app('compras-nombres', ['compras:write']);
    const r = await request(c).get('/cuentas-linea/nombres?tipo=gasto&codigos=640,608,628,700,abc,640');
    expect(r.status).toBe(200);
    // Solo las pedidas que son de gastos; 700 (de ventas) y «abc» no salen.
    expect((r.body.data ?? r.body).map((x: { codigo: string }) => x.codigo)).toEqual(['640', '608', '628']);
    expect((r.body.data ?? r.body).find((x: { codigo: string }) => x.codigo === '640').nombre).toMatch(/Sueldos/i);
    expect((await request(c).get('/cuentas-linea?tipo=gasto')).body.data.otras).toEqual([]);
    expect((await request(c).get('/cuentas-linea/nombres?tipo=gasto')).body.data).toEqual([]);
    // Quien solo lleva ventas no pregunta por cuentas de gastos.
    expect((await request(app('ventas-nombres', ['ventas:write'])).get('/cuentas-linea/nombres?tipo=gasto&codigos=640')).status).toBe(403);
  });

  it('bajo una cuenta de uso contable solo crea (o pide el siguiente codigo) quien tiene Contabilidad «Modificar»', async () => {
    const c = app('compras-uso-crear', ['compras:write']);
    for (const madre of ['630', '680', '640', '609']) {
      const r = await request(c).post('/cuentas-linea').send({ tipo: 'gasto', madre, nombre: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.details).toMatchObject({ permisos: ['contabilidad:write'], campo: 'madre' });
    }
    expect((await request(c).post('/cuentas-linea').send({ tipo: 'gasto', madre: '628', codigo: '6300099', nombre: 'X' })).status).toBe(403);
    expect((await request(c).get('/cuentas-linea/siguiente?tipo=gasto&madre=630')).status).toBe(403);
    expect((await request(app('ventas-uso', ['ventas:write'])).post('/cuentas-linea').send({ tipo: 'venta', madre: '708', nombre: 'X' })).status).toBe(403);
    // Una cuenta normal, si; y con Contabilidad «Modificar», tambien la de uso contable.
    expect((await request(c).post('/cuentas-linea').send({ tipo: 'gasto', madre: '628', nombre: 'Agua' })).status).toBe(201);
    expect((await request(app('contable-uso-crear', ['contabilidad:write'])).post('/cuentas-linea').send({ tipo: 'gasto', madre: '630', nombre: 'Impuesto' })).status).toBe(201);
  });

  it('contabilidad:write crea de cualquier tipo; el administrador siempre', async () => {
    expect((await request(app('contable', ['contabilidad:write'])).post('/cuentas-linea').send({ tipo: 'gasto', madre: '621', nombre: 'Local' })).status).toBe(201);
    expect((await request(app('admin', ['*'])).post('/cuentas-linea').send({ tipo: 'gasto', madre: '621', nombre: 'Nave' })).status).toBe(201);
  });

  it('sin permisos de facturas ni contabilidad: 403', async () => {
    expect((await request(app('rrhh', ['nominas:read'])).get('/cuentas-linea?tipo=gasto')).status).toBe(403);
  });
});

describe('ventas con cuenta por linea', () => {
  let clienteId: string;
  const linea = (precio: number, cuenta?: string | null, extra: Record<string, unknown> = {}) => ({
    descripcion: 'Concepto',
    cantidad: 1,
    precioUnitario: precio,
    tipoIva: 21,
    ...(cuenta !== undefined ? { cuenta } : {}),
    ...extra,
  });

  beforeAll(async () => {
    clienteId = String(((await clientesService.create(E, { nombreFiscal: 'Cliente Lineas SL', nifCif: cif() })) as unknown as { id: string }).id);
  });

  it('una linea de ingreso por cuenta, con el nombre del plan; sin cuenta, a la 700', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: { id: clienteId },
      fechaEmision: '2026-05-02',
      fechaVencimiento: '2099-12-31',
      lineas: [linea(100), linea(200, '70500010'), linea(50, '70500010'), linea(10, '705')],
    });
    expect(f.lineas.map((l) => l.cuenta)).toEqual([null, '70500010', '70500010', '705']);
    const a = await asiento((await motor.contabilizarFacturaIngreso(E, f.id)).journalEntryId);
    expect(porCuenta(a.lineas)).toMatchObject({ '700': [0, 100], '70500010': [0, 250], '705': [0, 10], '477': [0, 75.6] });
    expect(nombreDe(a.lineas, '70500010')).toBe('Consultoría');
    expect(a.lineas.filter((l) => l.accountCode.startsWith('70'))).toHaveLength(3);
  });

  it('sin ninguna cuenta: el asiento de siempre (700 «Ventas»)', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-05-03', fechaVencimiento: '2099-12-31', lineas: [linea(80)] });
    const a = await asiento((await motor.contabilizarFacturaIngreso(E, f.id)).journalEntryId);
    expect(porCuenta(a.lineas)['700']).toEqual([0, 80]);
    expect(nombreDe(a.lineas, '700')).toBe('Ventas');
  });

  it('la cuenta del producto: la suya, la de la familia o la 705 si es un servicio', async () => {
    const serv = await prisma.product.create({ data: { companyId: E, referencia: `S-${SUFIJO}`, descripcion: 'Hora', tipo: 'SERVICIO' } });
    const propia = await prisma.product.create({ data: { companyId: E, referencia: `P-${SUFIJO}`, descripcion: 'Caja', cuentaVentas: '70000001' } });
    const vieja = await prisma.product.create({ data: { companyId: E, referencia: `V-${SUFIJO}`, descripcion: 'Antiguo', cuentaVentas: '7019999' } });
    const f = await incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: { id: clienteId },
      fechaEmision: '2026-05-04',
      fechaVencimiento: '2099-12-31',
      lineas: [linea(10, undefined, { productoServicioId: serv.id }), linea(20, undefined, { productoServicioId: propia.id }), linea(30, undefined, { productoServicioId: vieja.id }), linea(5, '700', { productoServicioId: serv.id })],
    });
    // La cuenta antigua que ya no esta en el plan no bloquea: la linea va a la 700.
    expect(f.lineas.map((l) => l.cuenta)).toEqual(['705', '70000001', null, '700']);
  });

  it('cuenta que no es de ventas, inexistente o desactivada: 400 con la linea', async () => {
    const base = { companyId: E, customer: { id: clienteId }, fechaEmision: '2026-05-05', fechaVencimiento: '2099-12-31' };
    await expect(incomeInvoicesService.crearIngreso({ ...base, lineas: [linea(1), linea(1, '600')] })).rejects.toMatchObject({ statusCode: 400, details: { campo: 'lineas.1.cuenta' } });
    await expect(incomeInvoicesService.crearIngreso({ ...base, lineas: [linea(1, '7059999')] })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('no existe') });
    await prisma.chartOfAccounts.updateMany({ where: { companyId: E, codigo: '70000001' }, data: { activo: false } });
    await expect(incomeInvoicesService.crearIngreso({ ...base, lineas: [linea(1, '70000001')] })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('desactivada') });
    await prisma.chartOfAccounts.updateMany({ where: { companyId: E, codigo: '70000001' }, data: { activo: true } });
  });

  it('rectificativa total: las mismas cuentas en negativo; duplicar conserva las cuentas', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-05-06', fechaVencimiento: '2099-12-31', lineas: [linea(100), linea(40, '70500010')] });
    await motor.contabilizarFacturaIngreso(E, f.id);
    const rect = await incomeInvoicesService.crearRectificativa(E, f.id, { motivo: 'Anulación' });
    expect(rect.lineas.map((l) => l.cuenta)).toEqual([null, '70500010']);
    const a = await asiento((await motor.contabilizarFacturaIngreso(E, rect.id)).journalEntryId);
    expect(porCuenta(a.lineas)).toMatchObject({ '700': [0, -100], '70500010': [0, -40] });
    const copia = await incomeInvoicesService.duplicar(E, f.id);
    expect(copia.lineas.map((l) => l.cuenta)).toEqual([null, '70500010']);
  });

  it('rectificativa de una venta cuya cuenta se desactivo despues: va a la misma cuenta (total, borrador y por sustitucion)', async () => {
    const madre = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: '705' } });
    await prisma.chartOfAccounts.create({
      data: { id: `c-${SUFIJO}-7050077`, companyId: E, codigo: '7050077', nombre: 'Cursos', grupo: 7, nivel: madre.nivel + 1, naturaleza: madre.naturaleza, tipoUso: madre.tipoUso, esBasePGC: false, esPersonalizadaEmpresa: true, parentId: madre.id, parentCodigo: '705' },
    });
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-05-08', fechaVencimiento: '2099-12-31', lineas: [linea(500, '7050077')] });
    await motor.contabilizarFacturaIngreso(E, f.id);
    await prisma.chartOfAccounts.updateMany({ where: { companyId: E, codigo: '7050077' }, data: { activo: false } });
    try {
      // Una factura nueva no puede usarla...
      await expect(
        incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-05-08', fechaVencimiento: '2099-12-31', lineas: [linea(1, '7050077')] }),
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('desactivada') });
      // ...pero la rectificativa de la que la lleva, si (emitida, en borrador y editando el borrador).
      const rect = await incomeInvoicesService.crearRectificativa(E, f.id, { motivo: 'Anulación' });
      expect(rect.lineas.map((l) => l.cuenta)).toEqual(['7050077']);
      const a = await asiento((await motor.contabilizarFacturaIngreso(E, rect.id)).journalEntryId);
      expect(porCuenta(a.lineas)['7050077']).toEqual([0, -500]);
      const borrador = await incomeInvoicesService.crearRectificativa(E, f.id, { motivo: 'Descuento', borrador: true, tipoRectificativa: 'S', lineas: [linea(400, '7050077')] });
      expect(borrador.lineas.map((l) => l.cuenta)).toEqual(['7050077']);
      const editado = await incomeInvoicesService.actualizarBorrador(E, borrador.id, { lineas: [linea(300, '7050077')] });
      expect(editado.lineas.map((l) => l.cuenta)).toEqual(['7050077']);
      // Otra cuenta desactivada que no es de la original sigue sin valer.
      await prisma.chartOfAccounts.updateMany({ where: { companyId: E, codigo: '70000001' }, data: { activo: false } });
      await expect(incomeInvoicesService.actualizarBorrador(E, borrador.id, { lineas: [linea(300, '70000001')] })).rejects.toMatchObject({
        statusCode: 400,
        details: { campo: 'lineas.0.cuenta' },
      });
    } finally {
      await prisma.chartOfAccounts.updateMany({ where: { companyId: E, codigo: { in: ['7050077', '70000001'] } }, data: { activo: true } });
    }
  });

  it('editar un borrador cambia la cuenta de la linea', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, borrador: true, fechaEmision: '2026-05-07', fechaVencimiento: '2099-12-31', lineas: [linea(10)] });
    const editado = await incomeInvoicesService.actualizarBorrador(E, b.id, { lineas: [linea(10, '705')] });
    expect(editado.lineas.map((l) => l.cuenta)).toEqual(['705']);
  });
});

describe('gastos con cuenta por linea', () => {
  let provId: string;
  const compra = (lineas: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
    proveedor: { id: provId },
    numeroFacturaProveedor: `G-${n++}`,
    fechaEmision: '2026-05-10',
    tipoGasto: 'SUMINISTROS',
    lineas,
    ...extra,
  });
  const l = (precio: number, cuenta?: string) => ({ descripcion: 'Suministro', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...(cuenta ? { cuenta } : {}) });

  beforeAll(async () => {
    provId = (await proveedoresService.create(E, { nombreFiscal: 'Eléctrica SA', nifCif: cif() })).id;
  });

  it('una linea de gasto por cuenta, con el nombre de la subcuenta del plan', async () => {
    const r = await registrarGasto(E, compra([l(100, '62800001'), l(50, '62800002'), l(25)]), { contabilizar: 'POSTED' });
    const a = await asiento(r.asientoId);
    expect(porCuenta(a.lineas)).toMatchObject({ '62800001': [100, 0], '62800002': [50, 0], '628': [25, 0] });
    expect(nombreDe(a.lineas, '62800001')).toBe('Luz oficina');
    expect(nombreDe(a.lineas, '628')).toBe('Suministros');
  });

  it('editar la factura cambiando la cuenta de una linea: el asiento rehecho la usa', async () => {
    const alta = await registrarGasto(E, compra([l(100, '62800001')]), { contabilizar: 'POSTED' });
    await editarGasto(E, alta.factura.id, compra([l(100, '62800002')], { numeroFacturaProveedor: alta.factura.numeroFacturaProveedor }));
    const nuevo = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: E, invoiceId: alta.factura.id, origen: 'FACTURA_GASTO', estado: { not: 'REVERSED' } },
      include: { lineas: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(porCuenta(nuevo.lineas)).toMatchObject({ '62800002': [100, 0] });
    expect(porCuenta(nuevo.lineas)['62800001']).toBeUndefined();
  });

  it('una cuenta de ventas o inexistente en un gasto: 400 con la linea', async () => {
    await expect(registrarGasto(E, compra([l(10), l(10, '62899999')]), { contabilizar: 'POSTED' })).rejects.toMatchObject({
      statusCode: 400,
      details: { campo: 'lineas.1.cuenta' },
    });
  });

  // El ultimo del fichero: deja presentado el 303 del 1T de 2026.
  it('anular con el 303 presentado: el contraasiento invierte cada cuenta de linea', async () => {
    const alta = await registrarGasto(E, compra([l(100, '62800001'), l(40, '62800002'), l(10)], { fechaEmision: '2026-01-15' }), { contabilizar: 'POSTED' });
    await prisma.modeloImpuesto.create({ data: { companyId: E, codigo: '303', ejercicio: 2026, periodo: '1T', estado: 'presentado' } });
    const r = await anularGasto(E, alta.factura.id, { motivo: 'El proveedor la anuló', fecha: '2026-04-20' });
    expect(r.contraasiento).toBe(true);
    const c = await asiento(r.asientoAnulacionId!);
    expect(porCuenta(c.lineas)).toMatchObject({ '62800001': [0, 100], '62800002': [0, 40], '628': [0, 10] });
    expect(nombreDe(c.lineas, '62800001')).toBe('Luz oficina');
  });
});
