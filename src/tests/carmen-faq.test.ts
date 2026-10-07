/**
 * Carmen, capa 2: fichas verificadas, plazos y enlaces a pantallas.
 */
jest.mock('../config/database', () => ({ prisma: {} }));

import { existsSync } from 'fs';
import { join } from 'path';
import { FICHAS, type FichaFAQ } from '../services/carmen/faq/faq.data';
import { buscarFichas, fichaPorId, fichaServible, MARGEN_FAQ, UMBRAL_FAQ } from '../services/carmen/faq/faq';
import { plazosDelEjercicio, proximosPlazos, frasePlazo } from '../services/carmen/faq/calendario';
import { hrefValido, PANTALLAS } from '../services/carmen/menus';
import { fechaVencimientoModelo } from '../services/impuestosModulo.service';
import { hoyEspana } from '../utils/fechas';
import { INTENCIONES } from '../services/carmen/intenciones/catalogo';

const HOY = '2026-10-07';

/** Dos paráfrasis nuevas (que no están en la ficha) por cada ficha publicada. */
const PARAFRASIS: Record<string, [string, string]> = {
  'app-factura-nueva': ['¿Dónde emito una factura nueva?', 'quiero hacerle una factura a un cliente'],
  'app-rectificativa': ['¿Cómo hago una factura rectificativa?', 'tengo que anular una factura que ya mandé'],
  'app-proformas': ['¿Qué es una factura proforma?', '¿cómo convierto una proforma en factura?'],
  'app-registrar-gasto': ['¿Cómo registro una factura de compra?', '¿Dónde meto los gastos de proveedores?'],
  'app-importar-extracto': ['¿Cómo subo el extracto bancario?', 'importar el fichero norma 43 del banco'],
  'app-conciliar': ['¿Cómo funciona la conciliación bancaria?', '¿cómo cruzo los movimientos del banco con las facturas?'],
  'app-categorizar': ['¿Cómo pongo categorías a los movimientos del banco?', 'desglosar un cargo del banco en varias categorias'],
  'app-informes': ['¿Dónde está la cuenta de pérdidas y ganancias?', '¿Cómo descargo el libro mayor en Excel?'],
  'app-aprobar-asientos': ['¿Dónde se aprueban los asientos?', '¿dónde apruebo los asientos del motor contable?'],
  'app-cierre': ['¿Cómo se hace el cierre del ejercicio?', 'quiero hacer la regularización y el asiento de cierre'],
  'app-puesta-en-marcha': ['¿Cómo importo la contabilidad de otro programa?', 'cargar el balance de apertura de la empresa'],
  'app-modelo-303': ['¿Dónde preparo el modelo 303?', 'descargar el fichero del 303 para hacienda'],
  'app-permisos': ['¿Por qué me sale que me falta permiso?', '¿quién me puede dar acceso a tesorería?'],
  'app-datos-empresa': ['¿Dónde pongo el logo en las facturas?', 'cambiar los datos fiscales de mi empresa'],
  'cont-estados-asiento': ['¿Qué es un asiento en estado borrador?', '¿qué quiere decir que un asiento está anulado?'],
  'cont-no-sale-en-informes': ['¿Por qué no aparece una factura en el balance?', 'la venta no me sale en la cuenta de resultados'],
  'cont-asiento-venta': ['¿Cómo se contabiliza una factura de venta?', '¿qué cuentas lleva el asiento de una venta?'],
  'cont-asiento-compra': ['¿Cómo se contabiliza una factura de proveedor?', '¿qué cuentas lleva el asiento de una compra?'],
  'cont-iva-repercutido-soportado': ['¿Qué es el IVA soportado?', 'diferencia entre el iva que cobro y el que pago'],
  'cont-pendiente-vs-saldo': ['¿Por qué no coincide lo pendiente del cliente con su saldo en el mayor?', 'el mayor del cliente no cuadra con lo pendiente de cobro'],  'iva-tipos': ['¿A qué tipo de IVA va el pan?', 'que iva se aplica a un restaurante'],
  'iva-recargo-equivalencia': ['¿Qué recargo le pongo a una tienda que está en recargo de equivalencia?', 'recargo de equivalencia para comerciantes minoristas'],
  'iva-isp': ['¿Cuándo hay inversión del sujeto pasivo en una obra?', 'factura de un subcontratista sin iva por isp'],
  'iva-intracomunitarias': ['¿Lleva IVA una venta a una empresa de Italia?', '¿qué es el registro de operadores intracomunitarios?'],
  'iva-criterio-caja': ['¿Cómo funciona el régimen de criterio de caja?', 'quiero declarar el iva solo cuando cobro'],
  'iva-coche': ['¿Cuánto IVA del coche de la empresa puedo deducir?', 'deducción del iva del vehículo al 50'],
  'iva-plazo-deducir': ['¿Puedo deducir el IVA de una factura del año pasado?', 'tengo una factura de compra que no metí en su trimestre'],
  'fact-simplificada': ['¿Hasta qué importe vale una factura simplificada?', 'puedo hacer un ticket en vez de factura'],
  'fact-plazo-emision': ['¿Hasta cuándo puedo emitir la factura de un servicio a una empresa?', 'cuál es el plazo para expedir una factura'],
  'fact-rectificativa-plazo': ['¿Es obligatoria una rectificativa si me equivoqué en el IVA?', 'cuál es el plazo para hacer una factura rectificativa'],
  'fact-conservacion': ['¿Cuántos años tengo que conservar la documentación?', 'cuánto tiempo hay que guardar los justificantes'],
  'fact-verifactu': ['¿Cuándo es obligatorio Verifactu para una sociedad?', 'verifactu fechas de obligatoriedad'],
  'fact-electronica-b2b': ['¿Cuándo es obligatoria la factura electrónica?', 'factura electrónica entre empresas plazos'],
  'irpf-suministros-casa': ['¿Puedo deducir los suministros de mi vivienda si trabajo en casa?', 'cuánto de la factura de la luz me deduzco trabajando en casa'],
  'irpf-manutencion': ['¿Puedo deducir lo que como cuando trabajo fuera?', 'límite de gastos de manutención del autónomo'],
  'irpf-dificil-justificacion': ['¿Cuánto son los gastos de difícil justificación?', 'el 5 por ciento de gastos de difícil justificación'],
  'irpf-retencion-profesionales': ['¿Cuándo puedo poner el 7 % de retención en mis facturas?', 'qué retención lleva una factura de un profesional'],
  'irpf-retencion-alquiler': ['¿Hay que retener en el alquiler de la oficina?', 'retención del alquiler de un local de negocio'],
  'is-tipos': ['¿Cuál es el tipo del Impuesto sobre Sociedades para una microempresa?', 'a qué tipo tributa una sociedad de nueva creación'],
  'is-amortizacion': ['¿En cuántos años se amortiza un ordenador?', 'coeficientes de la tabla de amortización'],
  'is-atenciones-clientes': ['¿Puedo deducir los regalos de Navidad a clientes?', 'son deducibles las comidas con clientes'],
  'lgt-recargos': ['¿Qué recargo tiene presentar fuera de plazo?', 'he presentado el iva tarde que me pasa'],
  'lgt-aplazamientos': ['¿Puedo fraccionar el pago de un impuesto?', 'aplazamiento de una deuda con hacienda sin garantía'],
  'lgt-prescripcion': ['¿Cuándo prescribe una declaración de impuestos?', 'cuántos años atrás puede revisarme hacienda'],
  'modelo-303-que-es': ['¿Para qué sirve el modelo 303?', 'qué tengo que revisar antes de presentar el 303'],
  'modelo-390-que-es': ['¿Para qué sirve el modelo 390?', 'qué es la declaración resumen anual del iva'],
  'modelo-347-que-es': ['¿Quién tiene que presentar el modelo 347?', 'qué es la declaración de operaciones con terceros'],
  'modelo-349-que-es': ['¿Para qué sirve el modelo 349?', 'el 349 se presenta cada mes o cada trimestre'],
  'modelo-111-que-es': ['¿Para qué sirve el modelo 111?', 'qué se declara en el modelo 111'],
  'modelo-115-que-es': ['¿Para qué sirve el modelo 115?', 'qué se declara en el modelo 115'],
  'modelo-200-que-es': ['¿Para qué sirve el modelo 200?', 'qué reviso antes de presentar el impuesto de sociedades'],
};

const publicadas = FICHAS.filter((f) => fichaServible(f, HOY));

describe('fichas publicadas', () => {
  it('hay fichas y todas las publicadas tienen su paráfrasis en este test', () => {
    expect(publicadas.length).toBeGreaterThanOrEqual(15);
    expect(publicadas.map((f) => f.id).sort()).toEqual(Object.keys(PARAFRASIS).sort());
  });

  it('ids únicos', () => {
    expect(new Set(FICHAS.map((f) => f.id)).size).toBe(FICHAS.length);
  });

  it.each(publicadas.map((f) => [f.id, f] as const))('%s: fuente, fechas, 120 palabras como máximo y sin emojis', (_id, f) => {
    expect(f.fuente.titulo).toBeTruthy();
    expect(f.fuente.url).toMatch(/^(https:\/\/|\/dashboard)/);
    expect(f.verificadaEl).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Falla el día que una ficha caduca: hay que revisarla (y volver a fecharla).
    expect(f.revisarAntes > hoyEspana()).toBe(true);
    expect(f.respuesta.split(/\s+/).length).toBeLessThanOrEqual(120);
    expect(f.respuesta).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(f.variantes.length).toBeGreaterThanOrEqual(5);
    if (f.enlaceApp) expect(hrefValido(f.enlaceApp.href)).toBe(true);
    if (f.intencionRelacionada) expect(INTENCIONES.some((i) => i.id === f.intencionRelacionada)).toBe(true);
  });

  it.each(publicadas.map((f) => [f.id, f] as const))('%s sale la primera con su pregunta y con dos paráfrasis nuevas', (id, f) => {
    for (const pregunta of [f.pregunta, ...PARAFRASIS[id]]) {
      const [primera, segunda] = buscarFichas(pregunta, HOY, 2);
      expect({ pregunta, id: primera?.ficha.id }).toEqual({ pregunta, id });
      if (pregunta === f.pregunta) {
        expect(primera.puntuacion).toBeGreaterThanOrEqual(UMBRAL_FAQ);
        expect(primera.puntuacion - (segunda?.puntuacion ?? 0)).toBeGreaterThanOrEqual(MARGEN_FAQ);
      }
    }
  });
});

describe('fichas sin verificar o fuera de plazo', () => {
  const base: FichaFAQ = { ...FICHAS[0], id: 'prueba' };
  it('no se sirven nunca', () => {
    expect(fichaServible({ ...base, verificada: false }, HOY)).toBe(false);
    expect(fichaServible({ ...base, revisarAntes: '2026-10-06' }, HOY)).toBe(false);
    expect(fichaServible({ ...base, vigenteHasta: '2026-06-30' }, HOY)).toBe(false);
    expect(fichaServible({ ...base, vigenteDesde: '2027-01-01' }, HOY)).toBe(false);
    expect(fichaServible(base, HOY)).toBe(true);
    expect(fichaPorId('no-existe', HOY)).toBeNull();
    // Pasada su fecha de revisión, ni se busca ni se sirve por id.
    expect(fichaPorId(FICHAS[0].id, '2027-10-08')).toBeNull();
    expect(buscarFichas(FICHAS[0].pregunta, '2027-10-08')).toEqual([]);
  });
});

describe('plazos', () => {
  it('coinciden con fechaVencimientoModelo en los modelos que comparten', () => {
    for (const ejercicio of [2025, 2026, 2027]) {
      for (const p of plazosDelEjercicio(ejercicio)) {
        if (['303', '111', '115', '349'].includes(p.modelo) || ['390', '200'].includes(p.modelo)) {
          expect({ m: p.modelo, per: p.periodo, f: p.fecha }).toEqual({ m: p.modelo, per: p.periodo, f: fechaVencimientoModelo(p.modelo, ejercicio, p.periodo) });
        }
      }
    }
  });

  it('el 347 vence el último día de febrero (29 en bisiesto) y el 4T del 111 el 20 de enero', () => {
    expect(plazosDelEjercicio(2027).find((p) => p.modelo === '347')?.fecha).toBe('2028-02-29');
    expect(plazosDelEjercicio(2026).find((p) => p.modelo === '111' && p.periodo === '4T')?.fecha).toBe('2027-01-20');
    expect(plazosDelEjercicio(2026).find((p) => p.modelo === '190')?.fecha).toBe('2027-01-31');
  });

  it('próximo plazo del 303 a 07/10/2026: el 3T, hasta el 20/10/2026', () => {
    const [p] = proximosPlazos(HOY, 1, '303');
    expect(p).toMatchObject({ periodo: '3T', ejercicio: 2026, fecha: '2026-10-20' });
    expect(frasePlazo(p, HOY)).toBe('El modelo 303 (IVA trimestral) del 3T de 2026 se presenta hasta el 20/10/2026 (quedan 13 días).');
    const [enero] = proximosPlazos('2027-01-05', 1, '303');
    expect(enero).toMatchObject({ periodo: '4T', ejercicio: 2026, fecha: '2027-01-30' });
  });
});

describe('enlaces de las respuestas', () => {
  it('todas las pantallas del mapa de menús son enlaces válidos', () => {
    for (const p of PANTALLAS) expect(hrefValido(p.href)).toBe(true);
    expect(hrefValido('/dashboard/facturas/abc123')).toBe(true);
    expect(hrefValido('/dashboard/informes?tipo=pyg')).toBe(true);
    expect(hrefValido('/dashboard/no-existe')).toBe(false);
    expect(hrefValido('https://otra-web.com')).toBe(false);
  });

  // Solo en local, con el frontend al lado: cada pantalla existe en app/dashboard.
  const app = join(__dirname, '..', '..', '..', 'frontend-carmen', 'web', 'app', 'dashboard');
  (existsSync(app) ? it : it.skip)('cada pantalla del mapa existe en el frontend', () => {
    for (const p of PANTALLAS) {
      const ruta = p.href.replace(/^\/dashboard\/?/, '');
      expect({ href: p.href, existe: existsSync(join(app, ruta, 'page.tsx')) }).toEqual({ href: p.href, existe: true });
    }
  });
});
