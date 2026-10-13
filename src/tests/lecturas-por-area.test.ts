// Las lecturas piden el permiso de su area (estatico, sin BD).
//
// Antes unas 70 rutas GET de empresa no llevaban authorize(): las protegia solo
// companyScope y cualquier miembro de la empresa las leia. Con los permisos a
// medida, la casilla "Ver" de un area no habria servido de nada. Regla: area
// O contabilidad:read (los libros ya contienen ventas, compras y movimientos);
// Nominas va aparte, solo con nominas:read. Como los perfiles fijos tienen
// todos contabilidad:read, ninguno pierde una sola lectura.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { cubrePermisos, permisosDeRoles } from '../services/rbac.service';

const DIR_RUTAS = join(__dirname, '..', 'routes');

/**
 * Lecturas que siguen abiertas a cualquier miembro de la empresa, con su motivo.
 * Son de apoyo, no muestran importes, y sin ellas no funcionan los formularios.
 */
const LECTURAS_ABIERTAS: Record<string, string> = {
  'auth.routes.ts GET /health': 'publica',
  'auth.routes.ts GET /me': 'usuario y permisos de la propia sesion',
  'companies.routes.ts GET /': 'empresas del propio usuario',
  'companies.routes.ts GET /:id': 'datos basicos de una empresa propia (companyScope)',
  'docs.ts GET /docs': 'documentacion',
  'docs.ts GET /docs/modules': 'documentacion',
  'docs.ts GET /docs/states': 'documentacion',
  'docs.ts GET /docs/validation': 'documentacion',
  'planContableBase.routes.ts GET /grupos': 'plan PGC generico, ya publico',
  'planContableBase.routes.ts GET /subgrupos': 'plan PGC generico, ya publico',
  'planContableBase.routes.ts GET /cuentas': 'plan PGC generico, ya publico',
  'planContableBase.routes.ts GET /todo': 'plan PGC generico, ya publico',
  'legalConfig.routes.ts GET /': 'datos de la empresa para las facturas',
  'legalConfig.routes.ts GET /logo': 'logo de la empresa para las facturas',
  'plantillasDocumento.routes.ts GET /': 'plantillas de factura',
  'plantillasDocumento.routes.ts GET /tipo/:tipoDocumento/predeterminada': 'plantilla de factura predeterminada',
  'plantillasDocumento.routes.ts GET /:plantillaId': 'plantilla de factura',
  'bancos.routes.ts GET /cuentas': 'cuentas del banco (sin saldos) del formulario de cobros de una factura',
  'reglasContables.routes.ts GET /': 'reglas de contabilizacion que aplican los formularios',
  'ocr.routes.ts GET /ocr/status': 'si el lector esta disponible',
  'anios.routes.ts GET /': 'solo los años de la empresa para los desplegables, sin importes (spec arranque-2027, A.2.1)',
  'chatAssistant.routes.ts GET /estado': 'Carmen comprueba el permiso en cada intencion',
  'chatAssistant.routes.ts GET /catalogo': 'Carmen comprueba el permiso en cada intencion',
  'chatAssistant.routes.ts GET /sesiones': 'conversaciones propias; Carmen oculta lo que ya no puede ver',
  'chatAssistant.routes.ts GET /:sessionId/messages': 'conversaciones propias; Carmen oculta lo que ya no puede ver',
};

const V = ['ventas:read', 'contabilidad:read'];
const C = ['compras:read', 'contabilidad:read'];
const O = ['compras:read', 'ventas:read', 'contabilidad:read'];
const T = ['tesoreria:read', 'contabilidad:read'];
const M = ['contabilidad:read', 'tesoreria:read'];
const I = ['impuestos:read', 'contabilidad:read'];
const K = ['contabilidad:read'];

/** Las lecturas cerradas en este trabajo, con el permiso que piden. */
const LECTURAS_POR_AREA: Record<string, string[]> = {
  'clientes.routes.ts GET /': V,
  'clientes.routes.ts GET /:id': V,
  'productos.routes.ts GET /familias': V,
  'productos.routes.ts GET /siguiente-codigo': V,
  'productos.routes.ts GET /': V,
  'productos.routes.ts GET /:id': V,
  'income-invoices.routes.ts GET /': V,
  'income-invoices.routes.ts GET /resumen/periodo': V,
  'income-invoices.routes.ts GET /:id': V,
  'income-invoices.routes.ts GET /:id/pdf': V,
  'income-invoices.routes.ts GET /:id/avisos': V,
  'income-reader.routes.ts GET /pending': V,
  'income-reader.routes.ts GET /:id': V,
  'income-reader.routes.ts GET /config': V,
  'invoice-extractor.routes.ts GET /:id': V,
  'proveedores.routes.ts GET /': C,
  'proveedores.routes.ts GET /:id': C,
  'compras.routes.ts GET /': C,
  'compras.routes.ts GET /:id': C,
  // Compras: facturas de gasto y ficha del proveedor.
  'expense-invoices.routes.ts GET /': C,
  'expense-invoices.routes.ts GET /:id': C,
  'expense-invoices.routes.ts GET /:id/pagos': C,
  'proveedores.routes.ts GET /buscar': C,
  'proveedores.routes.ts GET /por-nif/:nif': C,
  'proveedores.routes.ts GET /:supplierId/contacts': C,
  'proveedores.routes.ts GET /:supplierId/bank-accounts': C,
  'proveedores.routes.ts GET /:supplierId/audit-trail': C,
  'proveedores.routes.ts GET /:supplierId/invoices': C,
  'proveedores.routes.ts GET /:supplierId/export': C,
  'ocr-sessions.routes.ts GET /ocr/sessions': O,
  'ocr-sessions.routes.ts GET /ocr/sessions/:sessionId': O,
  'ocr-sessions.routes.ts GET /ocr/stats': O,
  'ocr-analytics.routes.ts GET /analytics/kpis': O,
  'ocr-analytics.routes.ts GET /analytics/timeline': O,
  'ocr-analytics.routes.ts GET /analytics/distribution': O,
  'ocr-analytics.routes.ts GET /analytics/global': O,
  'bancos.routes.ts GET /movimientos': T,
  'movements.routes.ts GET /': M,
  'movements.routes.ts GET /stats/summary': M,
  'movements.routes.ts GET /stats/fiscal': M,
  'movements.routes.ts GET /stats/by-category': M,
  'movements.routes.ts GET /stats/by-month': M,
  'movements.routes.ts GET /stats/ingresos-por-cliente': [...M, 'ventas:read'],
  'movements.routes.ts GET /stats/gastos-por-proveedor': M,
  'movements.routes.ts GET /stats/ultimas-facturas': M,
  'reports.routes.ts GET /income': V,
  'reports.routes.ts GET /analytics/by-customer': V,
  'reports.routes.ts GET /expenses': C,
  'reports.routes.ts GET /vat': I,
  'reports.routes.ts GET /retentions': I,
  'reports.routes.ts GET /treasury': T,
  'reports.routes.ts GET /result': K,
  'reports.routes.ts GET /analytics/monthly': K,
  'tax.routes.ts GET /vat/books/issued': I,
  'tax.routes.ts GET /vat/books/received': I,
  'tax.routes.ts GET /vat/summary': I,
  'tax.routes.ts GET /retentions/summary': I,
  'tax.routes.ts GET /export/modelo-303': I,
  'accounting-closure.routes.ts GET /': K,
  'accounting-closure.routes.ts GET /:ejercicio': K,
  'accounting-closure.routes.ts GET /:ejercicio/files': K,
  'accounting-closure.routes.ts GET /prior-years/:ejercicio': K,
  'accounting-closure.routes.ts GET /prior-years': K,
  'accounting-closure.routes.ts GET /comparativas/:ej1/:ej2': K,
  // Configuracion: ejercicios y periodos (Contabilidad), facturacion y series (Ventas).
  'periodos.routes.ts GET /': K,
  'periodos.routes.ts GET /cierre': K,
  'fiscalYears.routes.ts GET /': K,
  'ajustesFacturacion.routes.ts GET /': V,
  'series.routes.ts GET /': V,
  'registroMercantil.routes.ts GET /fiscal-years/:fyId/deadlines': K,
  'registroMercantil.routes.ts GET /fiscal-years/:fyId/books': K,
  'registroMercantil.routes.ts GET /books/:bookId/download': K,
  'registroMercantil.routes.ts GET /fiscal-years/:fyId/legalization-packages': K,
  'registroMercantil.routes.ts GET /legalization-packages/:packageId/download': K,
  'registroMercantil.routes.ts GET /fiscal-years/:fyId/annual-accounts': K,
  'registroMercantil.routes.ts GET /fiscal-years/:fyId/memoria': K,
  'registroMercantil.routes.ts GET /annual-accounts/:id/download': K,
  'registroMercantil.routes.ts GET /annual-accounts/:id/xbrl': K,
  'tiposCambio.routes.ts GET /': ['ventas:read', 'compras:read', 'contabilidad:read', 'tesoreria:read'],
};

/**
 * Lecturas nuevas que piden solo su permiso, sin la alternativa de
 * contabilidad:read: no las tenia nadie antes, asi que ningun perfil las pierde.
 */
const LECTURAS_SOLO_SU_PERMISO: Record<string, string[]> = {
  'ajustesFiscales.routes.ts GET /': ['impuestos:read'],
  'miembros.routes.ts GET /': ['admin:empresa'],
};

/** Cada GET de las rutas: { 'fichero GET /ruta': permisos de su authorize en linea (null si no lleva) }. */
function lecturas(): Map<string, string[] | null> {
  const mapa = new Map<string, string[] | null>();
  for (const fichero of readdirSync(DIR_RUTAS).filter((f) => f.endsWith('.ts'))) {
    const codigo = readFileSync(join(DIR_RUTAS, fichero), 'utf-8');
    const protegidoPorFichero = /\.use\(\s*authorize\(/.test(codigo);
    // Misma expresion que rutasEscrituraSinAuthorize (permisos-rutas.test.ts).
    for (const m of codigo.matchAll(/\b\w+\.(get)\(\s*'([^']*)'([\s\S]*?)\);/g)) {
      const a = m[3].match(/authorize\(([^)]*)\)/);
      const permisos = a ? [...a[1].matchAll(/'([^']+)'/g)].map((p) => p[1]) : protegidoPorFichero ? ['(fichero)'] : null;
      mapa.set(`${fichero} GET ${m[2]}`, permisos);
    }
  }
  return mapa;
}

describe('lecturas por area', () => {
  const todas = lecturas();

  it('toda ruta GET pide un permiso o esta en la lista de lecturas abiertas, con su motivo', () => {
    const sinPermiso = [...todas].filter(([ruta, permisos]) => permisos === null && !(ruta in LECTURAS_ABIERTAS)).map(([ruta]) => ruta);
    expect(sinPermiso).toEqual([]);
    // Y la lista abierta no tiene rutas que ya no existen ni que ya piden permiso.
    const sobran = Object.keys(LECTURAS_ABIERTAS).filter((r) => todas.get(r) !== null);
    expect(sobran).toEqual([]);
  });

  it('las lecturas cerradas piden exactamente su area o contabilidad', () => {
    const distintas = Object.entries({ ...LECTURAS_POR_AREA, ...LECTURAS_SOLO_SU_PERMISO })
      .filter(([ruta, esperado]) => JSON.stringify([...(todas.get(ruta) ?? [])].sort()) !== JSON.stringify([...esperado].sort()))
      .map(([ruta]) => `${ruta}: ${JSON.stringify(todas.get(ruta))}`);
    expect(distintas).toEqual([]);
  });

  it('ningun perfil fijo pierde una lectura', () => {
    for (const perfil of ['contable', 'ventas', 'solo_lectura']) {
      const permisos = permisosDeRoles([perfil]);
      const perdidas = Object.entries(LECTURAS_POR_AREA)
        .filter(([, necesarios]) => !cubrePermisos(permisos, necesarios))
        .map(([ruta]) => ruta);
      expect(`${perfil}: ${perdidas.join(', ')}`).toBe(`${perfil}: `);
    }
  });

  it('nominas y trabajadores no se abren con contabilidad:read', () => {
    for (const fichero of ['nominas.routes.ts', 'empleados.routes.ts']) {
      const codigo = readFileSync(join(DIR_RUTAS, fichero), 'utf-8');
      expect(codigo).not.toMatch(/contabilidad:read/);
      for (const [ruta, permisos] of todas) {
        if (ruta.startsWith(`${fichero} `)) expect(`${ruta}: ${JSON.stringify(permisos)}`).toBe(`${ruta}: ["nominas:read"]`);
      }
    }
  });
});
