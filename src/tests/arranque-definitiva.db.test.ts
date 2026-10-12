/**
 * Cierre definitivo de la gestoria sobre una carga provisional:
 *  - enero abierto: la apertura se sustituye por la nueva;
 *  - enero bloqueado: asiento de ajuste de la apertura (APAJ) solo con las
 *    diferencias, con motivo, y nunca sobre el IVA (472/477);
 *  - los bancos (572) no pueden cambiar;
 *  - facturas pendientes con cobros: siguen si la cartera nueva las trae
 *    igual; si cambian o desaparecen, error.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { confirmarCarga } from '../services/arranque/aplicar.service';
import { quitarFichero, reanalizar, subirYAnalizar, type RespuestaCarga } from '../services/arranque/cargas.service';
import { AJUSTES_A, CARTERA_A, ficherosEmpresaA, ficherosEmpresaADefinitiva, INMOVILIZADO_A, type AsientoPrueba } from './fixtures/arranque/generar';
import { aplicarTodo, empresaDePrueba, TODOS, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const SUFIJO = Date.now();

/** La gestoria apunta 100 € mas de amortizacion de la maquinaria: el resultado baja a 7.100. */
const AMORT_EXTRA: AsientoPrueba = { numero: 12, fecha: '2026-12-31', concepto: 'Amortización complementaria', lineas: [['6810000000', 100, 0], ['2813000000', 0, 100]] };
const INMOV_DEF = INMOVILIZADO_A.map((b, i) => (i === 0 ? { ...b, acumulada: 3100 } : b));
const AJUSTES_DEF = { ...AJUSTES_A, tipoCarga: 'DEFINITIVA', resultadoDeclarado: 7100 };

const ficheros = (fs: Record<string, { nombre: string; contenido: Buffer }>) => Object.values(fs).map((f) => ({ nombre: f.nombre, contenido: f.contenido }));
const saldosApertura = async (companyId: string) => {
  const lineas = await prisma.journalEntryLine.findMany({
    where: { companyId, entry: { estado: 'POSTED', origen: { in: ['APERTURA', 'APERTURA_AJUSTE'] } } },
    select: { accountCode: true, debe: true, haber: true },
  });
  const m = new Map<string, number>();
  for (const l of lineas) m.set(l.accountCode, Math.round((((m.get(l.accountCode) ?? 0) + Number(l.debe) - Number(l.haber)) * 100)) / 100);
  return m;
};
const errores = (r: RespuestaCarga) => r.vista.comprobaciones.puntos.filter((p) => p.nivel === 'ERROR').map((p) => p.texto).join(' | ');

/** Como en la pantalla: quita del borrador los ficheros con el mismo nombre y sube los nuevos. */
async function cambiarFicheros(companyId: string, r: RespuestaCarga, nuevos: Array<{ nombre: string; contenido: Buffer }>, ajustes: unknown): Promise<RespuestaCarga> {
  for (const f of r.carga.ficheros.filter((x) => nuevos.some((n) => n.nombre === x.nombre))) await quitarFichero(companyId, 2027, r.carga.id, f.sha256);
  return subirYAnalizar(companyId, 2027, USUARIO_PRUEBA, nuevos, ajustes, TODOS);
}

async function bloquearEnero(companyId: string) {
  await prisma.periodo.upsert({
    where: { companyId_ejercicio_mes: { companyId, ejercicio: 2027, mes: 1 } },
    create: { companyId, ejercicio: 2027, mes: 1, estado: 'bloqueado' },
    update: { estado: 'bloqueado' },
  });
}

describe('definitiva con enero abierto: se sustituye la apertura', () => {
  const E = `arr-def-a-${SUFIJO}`;
  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
  }, 120_000);

  it('enseña la comparación por subcuenta y el modo, y al aplicar deja una sola apertura con las cifras nuevas', async () => {
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, ficheros(ficherosEmpresaADefinitiva([AMORT_EXTRA], { inmovilizado: INMOV_DEF })), AJUSTES_DEF, TODOS);
    expect(r.carga).toMatchObject({ version: 2, tipo: 'DEFINITIVA' });
    expect(errores(r)).toBe('');
    expect(r.vista.repeticion).toMatchObject({ modo: 'REEMPLAZAR', totalDiferencias: 2, partidasQueSiguen: 0, activosQueSiguen: 0 });
    expect(r.vista.repeticion!.textoModo).toMatch(/se sustituye por la nueva/);
    expect(r.vista.repeticion!.diferencias.map((d) => [d.subcuenta, d.anterior, d.nuevo, d.diferencia, d.movimientos2027])).toEqual([
      ['1290000000', -7200, -7100, 100, 0],
      ['2813000000', -3000, -3100, -100, 0],
    ]);

    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO_PRUEBA);
    await aplicarTodo(E, r.carga.id);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { companyId: E, origen: 'APERTURA_AJUSTE' } })).toBe(0);
    const s = await saldosApertura(E);
    expect(s.get('2813000000')).toBe(-3100);
    expect(s.get('1290000000')).toBe(-7100);
    const cargas = await prisma.cargaArranque.findMany({ where: { companyId: E }, orderBy: { version: 'asc' } });
    expect(cargas.map((c) => [c.version, c.tipo, c.estado])).toEqual([
      [1, 'PROVISIONAL', 'SUSTITUIDA'],
      [2, 'DEFINITIVA', 'CONFIRMADA'],
    ]);
    // El histórico de 2026 es el definitivo (12 asientos) y el torno trae la amortización nueva.
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: { startsWith: 'HISTORICO' } } })).toBe(12);
    expect(Number((await prisma.activoFijo.findFirstOrThrow({ where: { companyId: E, activo: true, descripcion: 'Torno CNC' } })).amortAcumuladaInicial)).toBe(3100);
  });

  it('una factura pendiente que ya tiene cobros sigue si la cartera nueva la trae igual; si cambia, error', async () => {
    const beta = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, estado: 'PENDIENTE', numeroDocumento: 'A-2026-002' } });
    await prisma.invoicePayment.create({
      data: { companyId: E, invoiceType: 'PARTIDA', invoiceId: beta.id, fecha: '2027-01-20', importe: 1000, cuentaTesoreria: '5720000001', estado: 'ACTIVO' },
    });

    // Cartera nueva en la que Beta ha cambiado: error con la lista.
    const cambiada = CARTERA_A.map((p) => (p.documento === 'A-2026-002' ? { ...p, documento: 'A-2026-002B' } : p));
    const mal = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, ficheros(ficherosEmpresaADefinitiva([AMORT_EXTRA], { inmovilizado: INMOV_DEF, cartera: cambiada })), AJUSTES_DEF, TODOS);
    expect(mal.vista.puedeConfirmar).toBe(false);
    expect(errores(mal)).toMatch(/Una factura pendiente que ya tiene cobros o pagos de 2027 cambia en la cartera nueva: A-2026-002 \(4300000002\): ya no está/);

    // Con la cartera de antes: Beta sigue (con su cobro) y pasa a la carga nueva.
    for (const f of mal.carga.ficheros.filter((x) => x.nombre === 'cartera_definitiva.xlsx')) await quitarFichero(E, 2027, mal.carga.id, f.sha256);
    const bien = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [ficherosEmpresaA().cartera], AJUSTES_DEF, TODOS);
    expect(bien.carga.id).toBe(mal.carga.id);
    expect(errores(bien)).toBe('');
    expect(bien.vista.repeticion).toMatchObject({ modo: 'REEMPLAZAR', totalDiferencias: 0, partidasQueSiguen: 1 });
    await confirmarCarga(E, 2027, bien.carga.id, bien.vista.huella, USUARIO_PRUEBA);
    await aplicarTodo(E, bien.carga.id);
    expect(await prisma.partidaPendiente.findUniqueOrThrow({ where: { id: beta.id } })).toMatchObject({ cargaId: bien.carga.id, estado: 'PENDIENTE' });
    expect(await prisma.partidaPendiente.count({ where: { companyId: E, estado: { not: 'ANULADA' } } })).toBe(CARTERA_A.length);
  });
});

describe('definitiva con enero bloqueado: asiento de ajuste de la apertura', () => {
  const E = `arr-def-b-${SUFIJO}`;
  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
    await bloquearEnero(E);
  }, 120_000);

  it('pide el motivo; con él, deja la apertura como estaba y apunta solo las diferencias el 1-1-2027', async () => {
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, ficheros(ficherosEmpresaADefinitiva([AMORT_EXTRA], { inmovilizado: INMOV_DEF })), AJUSTES_DEF, TODOS);
    expect(r.vista.repeticion!.modo).toBe('COMPLEMENTARIO');
    expect(r.vista.repeticion!.textoModo).toMatch(/Enero de 2027 está bloqueado/);
    expect(r.vista.puedeConfirmar).toBe(false);
    expect(errores(r)).toMatch(/Escribe el motivo del ajuste/);

    const conMotivo = await reanalizar(E, 2027, r.carga.id, USUARIO_PRUEBA, { motivoAjuste: 'Cierre definitivo: amortización que faltaba' }, TODOS);
    expect(errores(conMotivo)).toBe('');
    await confirmarCarga(E, 2027, r.carga.id, conMotivo.vista.huella, USUARIO_PRUEBA);
    const pasos = await aplicarTodo(E, r.carga.id);
    expect(pasos.find((p) => p.fase === 'APERTURA')!.hecho).toMatch(/^Asiento de ajuste APAJ-00001 con 2 líneas/);

    const apertura = await prisma.journalEntry.findMany({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' } });
    expect(apertura.map((a) => a.numeroAsiento)).toEqual(['APERT-00001']);
    const ajuste = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E, origen: 'APERTURA_AJUSTE' }, include: { lineas: true } });
    expect(ajuste).toMatchObject({ numeroAsiento: 'APAJ-00001', estado: 'POSTED' });
    expect(ajuste.fecha.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(ajuste.lineas.map((l) => [l.accountCode, Number(l.debe), Number(l.haber)]).sort()).toEqual([
      ['1290000000', 100, 0],
      ['2813000000', 0, 100],
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'ARRANQUE_CONFIRMAR', resourceId: r.carga.id } });
    expect(audit.meta).toMatchObject({ modoApertura: 'COMPLEMENTARIO', motivoAjuste: 'Cierre definitivo: amortización que faltaba' });
    // Apertura y ajuste juntos dan las cifras definitivas.
    const s = await saldosApertura(E);
    expect(s.get('1290000000')).toBe(-7100);
    expect(s.get('2813000000')).toBe(-3100);
  });

  let borrador: RespuestaCarga;
  it('si la diferencia toca el IVA (472/477), error: no se cambia el 303 ya presentado', async () => {
    const tardia: AsientoPrueba = { numero: 13, fecha: '2026-12-31', concepto: 'Factura de luz tardía', lineas: [['6280000000', 100, 0], ['4720000000', 21, 0], ['4100000001', 0, 121]] };
    borrador = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, ficheros(ficherosEmpresaADefinitiva([AMORT_EXTRA, tardia], { inmovilizado: INMOV_DEF })), { ...AJUSTES_DEF, resultadoDeclarado: 7000, motivoAjuste: 'Factura tardía' }, TODOS);
    expect(borrador.vista.repeticion!.modo).toBe('COMPLEMENTARIO');
    expect(borrador.vista.puedeConfirmar).toBe(false);
    expect(errores(borrador)).toMatch(/la diferencia toca el IVA \(4720000000\)/);
  });

  it('el saldo de un banco no puede cambiar entre la provisional y la definitiva', async () => {
    const comision: AsientoPrueba = { numero: 13, fecha: '2026-12-31', concepto: 'Comisión del banco', lineas: [['6280000000', 50, 0], ['5720000001', 0, 50]] };
    const def = ficherosEmpresaADefinitiva([AMORT_EXTRA, comision], { inmovilizado: INMOV_DEF });
    const r = await cambiarFicheros(E, borrador, [def.sumasSaldos, def.diario], { ...AJUSTES_DEF, resultadoDeclarado: 7050, motivoAjuste: 'Comisión' });
    expect(r.carga.id).toBe(borrador.carga.id);
    expect(r.vista.puedeConfirmar).toBe(false);
    expect(errores(r)).toMatch(/El saldo de los bancos a 31-12-2026 no puede cambiar de una carga a otra.*5720000001 \(18\.630,00 € y ahora 18\.580,00 €\)/);
  });
});
