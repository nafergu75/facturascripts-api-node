/**
 * «Traer la contabilidad de 2026» con varias personas (o pestañas) a la vez:
 *  - Confirmar mientras otra persona sube un fichero: la carga confirmada
 *    conserva sus ficheros y su confirmacion, o la confirmacion da 409.
 *  - Quitar el ultimo fichero borra el borrador (la pantalla vuelve al
 *    principio).
 *  - Dos /aplicar a la vez no duplican los bienes del inmovilizado.
 *  - Deshacer mientras se cobra una factura pendiente: nunca queda un cobro
 *    vivo contra una partida anulada.
 *  - Bancos, datos fiscales y avisos aceptados guardados a la vez no se pisan.
 *
 * Necesita MySQL.
 */
import { describe, it, expect } from '@jest/globals';
import { prisma } from '../config/database';
import { aplicarFase, confirmarCarga } from '../services/arranque/aplicar.service';
import { estadoArranque, quitarFichero, subirYAnalizar } from '../services/arranque/cargas.service';
import { deshacerCarga } from '../services/arranque/deshacer.service';
import { liquidarPartida } from '../services/arranque/partidas.service';
import { aceptarAviso, guardarBancos, guardarDatosFiscales } from '../services/arranque/seguimiento.service';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { aplicarTodo, empresaDePrueba, traerCarga, TODOS, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const SUFIJO = Date.now();
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('confirmar mientras otra persona sube un fichero', () => {
  for (const retraso of [0, 10, 30]) {
    it(`con ${retraso} ms de diferencia, la carga confirmada es la que se revisó`, async () => {
      const E = `arr-conc-sub-${retraso}-${SUFIJO}`;
      await empresaDePrueba(E);
      const { inmovilizado, ...resto } = ficherosEmpresaA();
      const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, Object.values(resto), AJUSTES_A, TODOS);
      expect(r.carga.ficheros).toHaveLength(6);
      const [conf, sub] = await Promise.allSettled([
        confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO_PRUEBA),
        espera(retraso).then(() => subirYAnalizar(E, 2027, USUARIO_PRUEBA, [inmovilizado], undefined, TODOS)),
      ]);
      const c = await prisma.cargaArranque.findUniqueOrThrow({ where: { id: r.carga.id } });
      const ficheros = (c.ficheros as unknown[]).length;
      const resumen = c.resumen as { confirmacion?: { huella: string; firma: string } } | null;
      if (conf.status === 'fulfilled') {
        // Confirmada: con sus 6 ficheros y su confirmacion; la subida no ha entrado en ella.
        expect(c.estado).toBe('APLICANDO');
        expect(ficheros).toBe(6);
        expect(resumen?.confirmacion?.huella).toBe(r.vista.huella);
        // La subida, si ha llegado despues, va a otro borrador nuevo o da 409.
        if (sub.status === 'fulfilled') expect(sub.value.carga.id).not.toBe(r.carga.id);
        else expect((sub.reason as { statusCode?: number }).statusCode).toBe(409);
        await aplicarTodo(E, r.carga.id);
      } else {
        expect((conf.reason as { statusCode?: number }).statusCode).toBe(409);
        expect(c.estado).toBe('BORRADOR');
      }
    }, 120_000);
  }

  it('una fase da 409 si los ficheros han cambiado despues de confirmar', async () => {
    const E = `arr-conc-firma-${SUFIJO}`;
    await empresaDePrueba(E);
    const { inmovilizado, ...resto } = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, Object.values(resto), AJUSTES_A, TODOS);
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO_PRUEBA);
    // Simula una escritura que se hubiera colado: un fichero mas en la carga confirmada.
    const c = await prisma.cargaArranque.findUniqueOrThrow({ where: { id: r.carga.id } });
    await prisma.cargaArranque.update({ where: { id: c.id }, data: { ficheros: [...(c.ficheros as object[]), { nombre: inmovilizado.nombre, sha256: 'x'.repeat(64), tamano: 1, clave: 'x' }] } });
    await expect(aplicarFase(E, 2027, r.carga.id, USUARIO_PRUEBA)).rejects.toMatchObject({ statusCode: 409, details: { codigo: 'CARGA_CAMBIADA' } });
  });
});

describe('quitar todos los ficheros del borrador', () => {
  it('borra el borrador y la pantalla vuelve al principio', async () => {
    const E = `arr-conc-quitar-${SUFIJO}`;
    await empresaDePrueba(E);
    const { plan, clientes } = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [plan, clientes], undefined, TODOS);
    const [a, b] = r.carga.ficheros;
    expect((await quitarFichero(E, 2027, r.carga.id, a.sha256)).borrada).toBe(false);
    const ultimo = await quitarFichero(E, 2027, r.carga.id, b.sha256);
    expect(ultimo).toEqual({ carga: null, borrada: true });
    expect(await prisma.cargaArranque.count({ where: { companyId: E } })).toBe(0);
    expect((await estadoArranque(E, 2027)).borrador).toBeNull();
    // Y se puede volver a subir: borrador nuevo.
    const otra = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [plan], undefined, TODOS);
    expect(otra.carga.ficheros).toHaveLength(1);
  });
});

describe('dos /aplicar a la vez', () => {
  it('no duplican el inmovilizado: una pasa y la otra da 409', async () => {
    const E = `arr-conc-apl-${SUFIJO}`;
    await empresaDePrueba(E);
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, Object.values(ficherosEmpresaA()), AJUSTES_A, TODOS);
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO_PRUEBA);
    // Hasta que la siguiente fase sea la del inmovilizado.
    for (let i = 0; i < 40; i++) {
      const c = await prisma.cargaArranque.findUniqueOrThrow({ where: { id: r.carga.id } });
      const pendiente = (c.fases as Array<{ fase: string; estado: string }>).find((f) => f.estado === 'PENDIENTE');
      if (pendiente?.fase === 'INMOVILIZADO') break;
      await aplicarFase(E, 2027, r.carga.id, USUARIO_PRUEBA);
    }
    const resultados = await Promise.allSettled([aplicarFase(E, 2027, r.carga.id, USUARIO_PRUEBA), aplicarFase(E, 2027, r.carga.id, USUARIO_PRUEBA)]);
    expect(resultados.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const fallo = resultados.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(fallo.reason.statusCode).toBe(409);
    expect(await prisma.activoFijo.count({ where: { companyId: E } })).toBe(2);
    await aplicarTodo(E, r.carga.id);
    expect(await prisma.activoFijo.count({ where: { companyId: E } })).toBe(2);
  }, 120_000);
});

describe('deshacer mientras se cobra una factura pendiente de 2026', () => {
  it('nunca queda un cobro vivo contra una partida anulada', async () => {
    const E = `arr-conc-desh-${SUFIJO}`;
    await empresaDePrueba(E);
    const { r } = await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
    const partida = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: 'A-2026-002' } });
    const resultados = await Promise.allSettled([
      deshacerCarga(E, 2027, r.carga.id, {}, USUARIO_PRUEBA),
      liquidarPartida(E, partida.id, { fecha: '2027-01-20', importe: 100, caja: true }, USUARIO_PRUEBA),
    ]);
    const cobrosVivos = await prisma.invoicePayment.count({ where: { companyId: E, invoiceType: 'PARTIDA', invoiceId: partida.id, estado: 'ACTIVO' } });
    const p = await prisma.partidaPendiente.findUniqueOrThrow({ where: { id: partida.id } });
    if (p.estado === 'ANULADA') expect(cobrosVivos).toBe(0);
    if (resultados[0].status === 'fulfilled') expect(cobrosVivos).toBe(0);
    if (cobrosVivos) expect(p.estado).not.toBe('ANULADA');
  }, 120_000);
});

describe('guardar a la vez bancos, datos fiscales y un aviso aceptado', () => {
  it('no se pisan: los tres quedan guardados', async () => {
    const E = `arr-conc-res-${SUFIJO}`;
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), { resultadoDeclarado: 7200 });
    await Promise.all([
      guardarDatosFiscales(E, 2027, { resultado303T4: 1785 }, USUARIO_PRUEBA),
      aceptarAviso(E, 2027, 'bancos:cuenta', 'La doy de alta en Bancos', USUARIO_PRUEBA),
      guardarBancos(E, 2027, { '5720000001': { saldoExtracto: 18630 } }, USUARIO_PRUEBA),
    ]);
    const c = await prisma.cargaArranque.findFirstOrThrow({ where: { companyId: E, estado: 'CONFIRMADA' } });
    const resumen = c.resumen as { datosFiscales?: { resultado303T4?: number }; avisosAceptados?: Array<{ clave: string }>; bancos?: Record<string, { saldoExtracto: number }>; resultadoDeclarado?: number };
    expect(resumen.datosFiscales?.resultado303T4).toBe(1785);
    expect(resumen.avisosAceptados?.map((a) => a.clave)).toEqual(['bancos:cuenta']);
    expect(resumen.bancos?.['5720000001']?.saldoExtracto).toBe(18630);
    expect(resumen.resultadoDeclarado).toBe(7200);
  }, 120_000);
});
