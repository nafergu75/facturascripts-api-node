/**
 * Borradores de los modelos 347, 390 y 200 con el diseño OFICIAL de la AEAT
 * (src/aeat/oficial). Una sola fuente para la pantalla y para el fichero: el
 * borrador (casillas, registros y avisos) y la descarga salen del mismo cálculo,
 * hecho al momento con las facturas y la contabilidad de la empresa.
 */
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import type { DatosModelo347, DesgloseIva, FacturaFiscal } from '../domain/impuestos.model';
import { construirModelo347, declarados347Desde, type Declaracion347 } from '../aeat/oficial/modelo347';
import { construirModelo390, type Declaracion390, type Entrada390 } from '../aeat/oficial/modelo390';
import { construirModelo200, type Declaracion200 } from '../aeat/oficial/modelo200';
import { agregar303, agregar347, agregar390, exigirModelosAeat, esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS, obtenerFacturasFiscales } from './impuestosCalculo.service';
import { calcularEstadosFinancieros } from './impuestoSociedadesCalculo.service';
import { listarCuentasBancarias } from './bancos.service';
import { periodoFiscal } from './nominas/fiscal';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Datos de la sociedad que guarda la app (Registro Mercantil > Datos para la memoria). */
async function datosSociedad(companyId: string) {
  const legal = await Promise.resolve()
    .then(() => prisma.legalConfig.findUnique({ where: { companyId } }))
    .catch(() => null);
  return {
    nif: legal?.nif ?? '',
    razonSocial: legal?.denominacion ?? '',
    telefono: legal?.telefono ?? null,
    email: legal?.email ?? null,
    actividad: legal?.actividad ?? null,
    cnae: legal?.cnae ?? null,
    fechaConstitucion: legal?.fechaConstitucion ?? null,
    ejercicioInicio: legal?.ejercicioInicio ?? '01-01',
    ejercicioFin: legal?.ejercicioFin ?? '12-31',
  };
}

// ---------------------------------------------------------------------------
// 347
// ---------------------------------------------------------------------------

export interface Opciones347 {
  contacto?: string | null;
  telefono?: string | null;
  complementaria?: { tipo: 'C' | 'S'; numeroAnterior: string } | null;
  numeroIdentificativo?: string;
}

export async function borrador347(companyId: string, ejercicio: number, opciones: Opciones347 = {}): Promise<Declaracion347 & { datos: DatosModelo347 }> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const [facturas, soc] = await Promise.all([obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`), datosSociedad(companyId)]);
  const datos = agregar347(facturas, ejercicio);
  const decl = construirModelo347(
    ejercicio,
    {
      nif: soc.nif,
      razonSocial: soc.razonSocial,
      telefono: opciones.telefono ?? soc.telefono,
      contacto: opciones.contacto ?? null,
      complementaria: opciones.complementaria ?? null,
      numeroIdentificativo: opciones.numeroIdentificativo,
    },
    declarados347Desde(datos),
  );
  return { ...decl, advertencias: [...(datos.advertencias ?? []), ...decl.advertencias], datos };
}

export async function fichero347(companyId: string, ejercicio: number, opciones: Opciones347 = {}) {
  const b = await borrador347(companyId, ejercicio, opciones);
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 347: ${b.errores.join(' ')}`);
  return { nombre: `347_${ejercicio}.txt`, contenido: b.fichero, advertencias: b.advertencias, numeroIdentificativo: b.declarante.numeroIdentificativo };
}

// ---------------------------------------------------------------------------
// 390
// ---------------------------------------------------------------------------

/** Adquisiciones intracomunitarias autoliquidadas por tipo: si la factura no trae cuota, se calcula al tipo de la linea o al 21 %. */
function autoliquidadas(compras: FacturaFiscal[]): DesgloseIva[] {
  const mapa = new Map<number, { base: number; cuota: number }>();
  for (const f of compras) {
    for (const l of f.lineas) {
      const tipo = l.tipoIva > 0 ? l.tipoIva : 21;
      const cuota = aCentimos(l.cuota) !== 0 ? aCentimos(l.cuota) : Math.round((aCentimos(l.base) * tipo) / 100);
      const a = mapa.get(tipo) ?? { base: 0, cuota: 0 };
      a.base += aCentimos(l.base);
      a.cuota += cuota;
      mapa.set(tipo, a);
    }
  }
  return [...mapa.entries()].map(([tipo, a]) => ({ tipo, base: a.base / 100, cuota: a.cuota / 100 }));
}

function porTipo(facturas: FacturaFiscal[]): DesgloseIva[] {
  const mapa = new Map<number, { base: number; cuota: number }>();
  for (const f of facturas) {
    for (const l of f.lineas) {
      const a = mapa.get(l.tipoIva) ?? { base: 0, cuota: 0 };
      a.base += aCentimos(l.base);
      a.cuota += aCentimos(l.cuota);
      mapa.set(l.tipoIva, a);
    }
  }
  return [...mapa.entries()].map(([tipo, a]) => ({ tipo, base: a.base / 100, cuota: a.cuota / 100 }));
}

/**
 * Entrada del 390 a partir de las facturas fiscales del año (logica pura).
 * Devengado: las ventas del regimen general (como el 303). Deducible: las
 * compras interiores deducibles. Las adquisiciones intracomunitarias se
 * autoliquidan (devengado y deducible por el mismo importe: no cambian el
 * resultado). Los resultados trimestrales son los del 303 de cada trimestre.
 */
export function entrada390Desde(
  facturas: FacturaFiscal[],
  ejercicio: number,
  identificacion: Entrada390['identificacion'],
  extra: Pick<Entrada390, 'compensarEjercicioAnterior' | 'ultimoPeriodo' | 'programa'> = {},
): { entrada: Entrada390; advertencias: string[] } {
  const datos = agregar390(facturas, ejercicio);
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)));
  const compras = delAno.filter((f) => f.tipo === 'compra');
  const deducibles = compras.filter((f) => f.deducible !== false);
  const intra = deducibles.filter((f) => f.operacion === 'intracomunitaria');
  const esServicio = (f: FacturaFiscal) => !!f.tipoGasto && f.tipoGasto !== 'COMPRA';
  const noDeducible = compras.filter((f) => f.deducible === false).reduce((a, f) => a + f.lineas.reduce((x, l) => x + aCentimos(l.base), 0), 0);
  const resultados = [1, 2, 3, 4].map((t) => agregar303(facturas, periodoFiscal(ejercicio, `${t}T`)).resultado) as Entrada390['resultadosTrimestrales'];
  const advertencias = [...(datos.advertencias ?? [])];
  if (intra.length) {
    advertencias.push(
      'Las adquisiciones intracomunitarias se autoliquidan en el 390 (devengado y deducible por el mismo importe, al tipo de la línea o al 21 %). Comprueba que coincide con lo que declaraste en los 303.',
    );
  }
  const importaciones = deducibles
    .filter((f) => f.operacion === 'exportacion')
    .map((f) => ({ ...f, lineas: f.lineas.filter((l) => aCentimos(l.cuota) !== 0) }));
  if (compras.some((f) => f.operacion === 'exportacion' && f.lineas.every((l) => aCentimos(l.cuota) === 0))) {
    advertencias.push('Hay compras a proveedores de fuera de la UE sin IVA en la factura: el IVA de la importación (DUA) solo entra si lo registras como gasto con su cuota.');
  }
  return {
    entrada: {
      ejercicio,
      identificacion,
      devengado: datos.resumenDevengado,
      adquisicionesIntraBienes: autoliquidadas(intra.filter((f) => !esServicio(f))),
      adquisicionesIntraServicios: autoliquidadas(intra.filter(esServicio)),
      deducibleInterior: porTipo(deducibles.filter((f) => f.operacion === 'interior')),
      importaciones: porTipo(importaciones),
      baseNoDeducible: noDeducible / 100,
      volumen: datos.volumen ?? {
        regimenGeneral: datos.volumenOperaciones,
        intracomunitarias: 0,
        exportacionesYExentasConDeduccion: 0,
        exentasSinDeduccion: 0,
        noSujetas: 0,
        isp: 0,
        total: datos.volumenOperaciones,
      },
      resultadosTrimestrales: resultados,
      ...extra,
    },
    advertencias,
  };
}

/** Cuotas a compensar que vienen del año anterior: la casilla [110] del 303 del 1T guardado (si lo hay). */
async function compensarDelAnoAnterior(companyId: string, ejercicio: number): Promise<number> {
  const fila = await Promise.resolve()
    .then(() => prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo: '303', ejercicio, periodo: '1T' } } }))
    .catch(() => null);
  const cas = (fila?.casillas ?? {}) as Record<string, unknown>;
  const clave = Object.keys(cas).find((k) => /^110(_|$)/.test(k));
  return clave ? Math.abs(Number(cas[clave]) || 0) : 0;
}

export interface Opciones390 {
  ultimoPeriodo?: 'compensar' | 'devolver';
  compensarEjercicioAnterior?: number;
}

export async function borrador390(companyId: string, ejercicio: number, opciones: Opciones390 = {}): Promise<Declaracion390> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const [facturas, soc, ajustes] = await Promise.all([
    obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`),
    datosSociedad(companyId),
    Promise.resolve()
      .then(() => prisma.ajustesFiscales.findUnique({ where: { companyId } }))
      .catch(() => null),
  ]);
  const compensar = opciones.compensarEjercicioAnterior ?? (await compensarDelAnoAnterior(companyId, ejercicio));
  const { entrada, advertencias } = entrada390Desde(
    facturas,
    ejercicio,
    {
      nif: soc.nif,
      razonSocial: soc.razonSocial,
      actividad: soc.actividad,
      cnae: soc.cnae,
      presenta347: agregar347(facturas, ejercicio).operaciones.length > 0,
      criterioCaja: !!ajustes?.criterioCaja,
      redeme: !!ajustes?.redeme,
    },
    { compensarEjercicioAnterior: compensar, ultimoPeriodo: opciones.ultimoPeriodo ?? 'compensar' },
  );
  const decl = construirModelo390(entrada);
  return { ...decl, advertencias: [...advertencias, ...decl.advertencias] };
}

export async function fichero390(companyId: string, ejercicio: number, opciones: Opciones390 = {}) {
  const b = await borrador390(companyId, ejercicio, opciones);
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 390: ${b.errores.join(' ')}`);
  return { nombre: `390_${ejercicio}.txt`, contenido: b.fichero, advertencias: b.advertencias };
}

// ---------------------------------------------------------------------------
// 200
// ---------------------------------------------------------------------------

export interface Opciones200 {
  binsPendientes?: number;
  pagosFraccionados?: [number, number, number];
  retenciones?: number;
  nuevaCreacion?: boolean;
  contacto?: string | null;
}

export async function borrador200(companyId: string, ejercicio: number, opciones: Opciones200 = {}): Promise<Declaracion200> {
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);
  const [estados, soc, cuentas, fy] = await Promise.all([
    calcularEstadosFinancieros(companyId, ejercicio),
    datosSociedad(companyId),
    listarCuentasBancarias(companyId).catch(() => []),
    Promise.resolve()
      .then(() => prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } }))
      .catch(() => null),
  ]);
  const anterior = estados.anterior.pyg;
  const hayAnterior = (anterior.partidas ?? []).some((x) => x.importe !== 0) || anterior.importeNetoCifraNegocios !== 0;
  const notas = (fy?.memoriaNotas ?? {}) as { plantillaMedia?: number | null };
  const decl = construirModelo200({
    ejercicio,
    identificacion: {
      nif: soc.nif,
      razonSocial: soc.razonSocial,
      cnae: soc.cnae,
      telefono: soc.telefono,
      email: soc.email,
      contacto: opciones.contacto ?? null,
      fechaInicio: fy?.fechaInicio ?? `${ejercicio}-${soc.ejercicioInicio}`,
      fechaFin: fy?.fechaFin ?? `${ejercicio}-${soc.ejercicioFin}`,
      fechaConstitucion: soc.fechaConstitucion,
    },
    balance: estados.balance,
    pyg: estados.pyg,
    reservaLegal: estados.reservaLegal,
    incnAnterior: hayAnterior ? anterior.importeNetoCifraNegocios : null,
    plantilla: notas.plantillaMedia != null ? { fijo: Number(notas.plantillaMedia) || 0, noFijo: 0 } : null,
    binsPendientes: opciones.binsPendientes,
    pagosFraccionados: opciones.pagosFraccionados,
    retenciones: opciones.retenciones,
    nuevaCreacion: opciones.nuevaCreacion,
    iban: cuentas.find((c) => c.activa)?.iban ?? null,
  });
  // Lo que hay en la 473 (retenciones y pagos a cuenta) ayuda a rellenar las casillas de la página 14 bis.
  let saldo473 = 0;
  for (const [cuenta, saldo] of estados.saldos.balance) if (cuenta.startsWith('473')) saldo473 += saldo;
  if (round2(saldo473) !== 0 && opciones.retenciones === undefined && opciones.pagosFraccionados === undefined) {
    decl.advertencias.unshift(
      `La cuenta 473 (retenciones y pagos a cuenta) tiene ${round2(saldo473).toFixed(2).replace('.', ',')} € al cierre: repártelos entre retenciones [01766] y pagos fraccionados [00601]-[00605].`,
    );
  }
  if (notas.plantillaMedia != null) decl.advertencias.push('La plantilla media de la memoria va entera como personal fijo [00041]: sepárala si hay personal no fijo.');
  return decl;
}

export async function fichero200(companyId: string, ejercicio: number, opciones: Opciones200 = {}) {
  const b = await borrador200(companyId, ejercicio, opciones);
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 200: ${b.errores.join(' ')}`);
  return { nombre: `200_${ejercicio}.txt`, contenido: b.fichero, advertencias: b.advertencias };
}
