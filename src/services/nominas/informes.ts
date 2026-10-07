/**
 * Informes de nominas para la empresa:
 *  - Coste de personal por mes o por trabajador (bruto, SS empresa,
 *    indemnizaciones y coste total), en JSON o Excel.
 *  - Prevision de pagos: liquidos contabilizados sin pagar (en su fecha de
 *    pago), seguros sociales pendientes (en su fecha de cargo) y el 111 de los
 *    trimestres que vencen en el rango (dia 20 del mes siguiente al trimestre).
 *    La tesoreria aun no tiene un servicio de prevision: esto deja los datos
 *    listos para cuando lo tenga.
 *  - Conciliacion: que pago de nominas puede ser un cargo del extracto.
 */
import * as XLSX from 'xlsx';
import { prisma } from '../../config/database';
import { badRequest, notFound } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { hoyEspana } from '../../utils/fechas';
import { CAMPOS_IMPORTE, type ImportesNomina } from '../../domain/nominas.model';
import { nombreCompleto } from '../empleados.service';
import { cuadreNomina } from './calculo';
import { periodoFiscal } from './fiscal';
import { listarSegurosSociales } from './segurosSociales';
import { importePago111, pagoModelo111 } from './tesoreria';
import { esEmpresaEspanolaFiscal } from '../impuestosCalculo.service';

const mm = (n: number) => String(n).padStart(2, '0');
const euros = (centimos: number): number => Math.round(centimos) / 100;
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ---------------------------------------------------------------------------
// Coste de personal
// ---------------------------------------------------------------------------

export interface FilaCoste {
  clave: string;
  etiqueta: string;
  mes?: number;
  empleadoId?: string;
  nif?: string;
  nominas: number;
  trabajadores: number;
  /** Retribuciones dinerarias (bruto sujeto a retencion). */
  bruto: number;
  dietas: number;
  indemnizaciones: number;
  /** Seguridad Social a cargo de la empresa. */
  ssEmpresa: number;
  /** Ingresos a cuenta de la especie que asume la empresa. */
  ingresosACuentaNoRepercutidos: number;
  /** Bruto + dietas + indemnizaciones + SS empresa + ingresos a cuenta no repercutidos. */
  costeEmpresa: number;
  /** Informativo: la especie se paga con la factura del proveedor (649). */
  especie: number;
  ssTrabajador: number;
  irpf: number;
  liquido: number;
  borradores: number;
}

export interface InformeCoste {
  ejercicio: number;
  agrupar: 'mes' | 'empleado';
  filas: FilaCoste[];
  totales: FilaCoste;
  avisos: string[];
}

type Acum = Omit<FilaCoste, 'trabajadores'> & { _trab: Set<string> };

const vacia = (clave: string, etiqueta: string, extra: Partial<FilaCoste> = {}): Acum => ({
  clave,
  etiqueta,
  ...extra,
  nominas: 0,
  bruto: 0,
  dietas: 0,
  indemnizaciones: 0,
  ssEmpresa: 0,
  ingresosACuentaNoRepercutidos: 0,
  costeEmpresa: 0,
  especie: 0,
  ssTrabajador: 0,
  irpf: 0,
  liquido: 0,
  borradores: 0,
  _trab: new Set<string>(),
});

function sumar(a: Acum, n: ImportesNomina & { empleadoId: string; estado: string }): void {
  const c = (v: number) => aCentimos(Number(v) || 0);
  a.nominas++;
  a._trab.add(n.empleadoId);
  a.bruto += c(n.brutoDinerario);
  a.dietas += c(n.dietasExentas);
  a.indemnizaciones += c(n.indemnizacionExenta) + c(n.indemnizacionSujeta);
  a.ssEmpresa += c(n.ssEmpresa);
  a.ingresosACuentaNoRepercutidos += n.ingresoACuentaRepercutido ? 0 : c(n.ingresoACuenta);
  a.costeEmpresa += c(cuadreNomina(n).costeEmpresa);
  a.especie += c(n.especieValoracion);
  a.ssTrabajador += c(n.ssTrabajador);
  a.irpf += c(n.irpf);
  a.liquido += c(n.liquido);
  if (n.estado === 'BORRADOR') a.borradores++;
}

function cerrar({ _trab, ...a }: Acum): FilaCoste {
  return {
    ...a,
    trabajadores: _trab.size,
    bruto: euros(a.bruto),
    dietas: euros(a.dietas),
    indemnizaciones: euros(a.indemnizaciones),
    ssEmpresa: euros(a.ssEmpresa),
    ingresosACuentaNoRepercutidos: euros(a.ingresosACuentaNoRepercutidos),
    costeEmpresa: euros(a.costeEmpresa),
    especie: euros(a.especie),
    ssTrabajador: euros(a.ssTrabajador),
    irpf: euros(a.irpf),
    liquido: euros(a.liquido),
  };
}

/** Coste de personal del ejercicio (mes de devengo), sin las nominas anuladas. */
export async function informeCoste(companyId: string, ejercicio: number, agrupar: 'mes' | 'empleado' = 'mes'): Promise<InformeCoste> {
  const nominas = await prisma.nomina.findMany({
    where: { companyId, ejercicio, estado: { not: 'ANULADA' } },
    include: { empleado: true },
    orderBy: [{ mes: 'asc' }],
  });
  const grupos = new Map<string, Acum>();
  if (agrupar === 'mes') for (let m = 1; m <= 12; m++) grupos.set(mm(m), vacia(mm(m), `${MESES[m - 1]} ${ejercicio}`, { mes: m }));
  const total = vacia('total', 'Total');
  for (const n of nominas) {
    const importes = { ingresoACuentaRepercutido: n.ingresoACuentaRepercutido } as ImportesNomina;
    for (const k of CAMPOS_IMPORTE) (importes as unknown as Record<string, number>)[k] = Number((n as unknown as Record<string, unknown>)[k] ?? 0);
    const fila = { ...importes, empleadoId: n.empleadoId, estado: n.estado };
    const clave = agrupar === 'mes' ? mm(n.mes) : n.empleadoId;
    let g = grupos.get(clave);
    if (!g) {
      g = vacia(clave, nombreCompleto(n.empleado), { empleadoId: n.empleadoId, nif: n.empleado.nif });
      grupos.set(clave, g);
    }
    sumar(g, fila);
    sumar(total, fila);
  }
  const filas = [...grupos.values()].map(cerrar);
  if (agrupar === 'empleado') filas.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'));
  const totales = cerrar(total);
  const avisos = totales.borradores ? [`${totales.borradores} nómina(s) siguen en borrador: cuentan en el coste, pero aún no están contabilizadas.`] : [];
  return { ejercicio, agrupar, filas, totales, avisos };
}

/** El informe de coste en Excel (una hoja, con la fila de totales). */
export function informeCosteExcel(inf: InformeCoste): Buffer {
  const cab = [
    inf.agrupar === 'mes' ? 'Mes' : 'Trabajador',
    ...(inf.agrupar === 'empleado' ? ['NIF'] : []),
    'Nóminas',
    'Trabajadores',
    'Bruto',
    'Dietas',
    'Indemnizaciones',
    'SS empresa',
    'Ingresos a cuenta asumidos',
    'Coste empresa',
    'Especie (informativo)',
    'SS trabajador',
    'IRPF',
    'Líquido',
  ];
  const fila = (f: FilaCoste) => [
    f.etiqueta,
    ...(inf.agrupar === 'empleado' ? [f.nif ?? ''] : []),
    f.nominas,
    f.trabajadores,
    f.bruto,
    f.dietas,
    f.indemnizaciones,
    f.ssEmpresa,
    f.ingresosACuentaNoRepercutidos,
    f.costeEmpresa,
    f.especie,
    f.ssTrabajador,
    f.irpf,
    f.liquido,
  ];
  const hoja = XLSX.utils.aoa_to_sheet([[`Coste de personal ${inf.ejercicio}`], [], cab, ...inf.filas.map(fila), fila(inf.totales)]);
  hoja['!cols'] = cab.map((t, i) => ({ wch: i === 0 ? 30 : Math.max(12, t.length + 2) }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, inf.agrupar === 'mes' ? 'Por mes' : 'Por trabajador');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ---------------------------------------------------------------------------
// Prevision de pagos
// ---------------------------------------------------------------------------

export interface PagoPrevisto {
  fecha: string;
  tipo: 'liquidos' | 'seguros_sociales' | 'modelo111';
  /** Categoria de tesoreria a la que corresponde. */
  categoria: 'Nóminas' | 'Seguridad Social' | 'Impuestos';
  concepto: string;
  importe: number;
  ejercicio: number;
  mes?: number;
  periodo?: string;
  /** La fecha ya ha pasado y sigue sin pagar. */
  vencido: boolean;
}

/** Fecha limite del 111 de un trimestre (dia 20 del mes siguiente; el 4T, el 20 de enero). */
export function vencimiento111(ejercicio: number, trimestre: number): string {
  return trimestre === 4 ? `${ejercicio + 1}-01-20` : `${ejercicio}-${mm(trimestre * 3 + 1)}-20`;
}

/**
 * Pagos de nominas previstos hasta `hasta` (los pendientes de fechas
 * anteriores a `desde` tambien salen, como vencidos; el 111, solo los
 * trimestres que vencen en el rango).
 */
export async function previsionPagos(companyId: string, desdeEntrada?: string, hastaEntrada?: string) {
  const hoy = hoyEspana();
  const desde = (desdeEntrada || hoy).slice(0, 10);
  const hasta = (hastaEntrada || new Date(new Date(`${desde}T00:00:00Z`).getTime() + 90 * 86400000).toISOString().slice(0, 10)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) throw badRequest('Rango de fechas no válido (desde y hasta, AAAA-MM-DD).');
  const pagos: PagoPrevisto[] = [];

  // Liquidos: las contabilizadas sin pagar, por mes y fecha de pago prevista.
  const pendientes = await prisma.nomina.findMany({
    where: { companyId, estado: 'CONTABILIZADA', fechaPago: { lte: hasta } },
    select: { ejercicio: true, mes: true, fechaPago: true, liquido: true, empleadoId: true },
  });
  const porGrupo = new Map<string, { ejercicio: number; mes: number; fecha: string; centimos: number; trabajadores: Set<string> }>();
  for (const n of pendientes) {
    const k = `${n.ejercicio}-${n.mes}-${n.fechaPago}`;
    const g = porGrupo.get(k) ?? { ejercicio: n.ejercicio, mes: n.mes, fecha: n.fechaPago, centimos: 0, trabajadores: new Set<string>() };
    g.centimos += aCentimos(Number(n.liquido));
    g.trabajadores.add(n.empleadoId);
    porGrupo.set(k, g);
  }
  for (const g of porGrupo.values()) {
    if (!g.centimos) continue;
    pagos.push({
      fecha: g.fecha,
      tipo: 'liquidos',
      categoria: 'Nóminas',
      concepto: `Nóminas ${mm(g.mes)}/${g.ejercicio} (${g.trabajadores.size} trabajador${g.trabajadores.size === 1 ? '' : 'es'})`,
      importe: euros(g.centimos),
      ejercicio: g.ejercicio,
      mes: g.mes,
      vencido: g.fecha < hoy,
    });
  }

  // Seguros sociales pendientes (del ano anterior al de `desde` en adelante).
  for (let ej = Number(desde.slice(0, 4)) - 1; ej <= Number(hasta.slice(0, 4)); ej++) {
    for (const ss of await listarSegurosSociales(companyId, ej)) {
      if (ss.estado !== 'PENDIENTE' || !ss.aPagar || ss.fechaCargoPrevista > hasta) continue;
      pagos.push({
        fecha: ss.fechaCargoPrevista,
        tipo: 'seguros_sociales',
        categoria: 'Seguridad Social',
        concepto: `Seguros sociales ${ss.tipo === 'COMPLEMENTARIA' ? 'complementarios ' : ''}${mm(ss.mes)}/${ss.ejercicio}${ss.totalRlc === null ? ' (previsto)' : ''}`,
        importe: ss.aPagar,
        ejercicio: ss.ejercicio,
        mes: ss.mes,
        vencido: ss.fechaCargoPrevista < hoy,
      });
    }
  }

  // 111: trimestres que vencen en el rango y no estan pagados. Una empresa no
  // establecida en Espana no presenta el 111.
  const presenta111 = await esEmpresaEspanolaFiscal(companyId);
  for (let ej = Number(desde.slice(0, 4)) - 1; presenta111 && ej <= Number(hasta.slice(0, 4)); ej++) {
    for (const t of [1, 2, 3, 4]) {
      const vence = vencimiento111(ej, t);
      if (vence < desde || vence > hasta) continue;
      if (await pagoModelo111(companyId, ej, `${t}T`)) continue;
      // Lo presentado (o editado en Impuestos) manda sobre el calculo: es lo que se ingresa.
      const d = await importePago111(companyId, periodoFiscal(ej, `${t}T`));
      if (aCentimos(d.total) <= 0) continue;
      pagos.push({
        fecha: vence,
        tipo: 'modelo111',
        categoria: 'Impuestos',
        concepto: `Modelo 111 ${t}T/${ej} (retenciones de nóminas y profesionales)`,
        importe: d.total,
        ejercicio: ej,
        periodo: `${t}T`,
        vencido: vence < hoy,
      });
    }
  }

  pagos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tipo.localeCompare(b.tipo));
  const totalPor = (f: (p: PagoPrevisto) => boolean) => euros(pagos.filter(f).reduce((a, p) => a + aCentimos(p.importe), 0));
  return {
    desde,
    hasta,
    pagos,
    totales: {
      total: totalPor(() => true),
      liquidos: totalPor((p) => p.tipo === 'liquidos'),
      segurosSociales: totalPor((p) => p.tipo === 'seguros_sociales'),
      modelo111: totalPor((p) => p.tipo === 'modelo111'),
      vencido: totalPor((p) => p.vencido),
    },
  };
}

// ---------------------------------------------------------------------------
// Conciliacion: que pago de nominas puede ser un cargo del banco
// ---------------------------------------------------------------------------

export interface SugerenciaPagoNominas {
  tipo: 'liquidos' | 'seguros_sociales' | 'modelo111';
  ejercicio: number;
  mes?: number;
  periodo?: string;
  concepto: string;
  importe: number;
  /** Endpoint con el que se registra el pago con este movimiento (movimientoId). */
  accion: string;
  incluirEmbargos?: boolean;
}

/**
 * Pagos de nominas pendientes cuyo importe coincide al centimo con un cargo del
 * banco: liquidos de un mes ("Pago nóminas MM/AAAA"), seguros sociales y 111.
 */
export async function sugerenciasMovimiento(companyId: string, movimientoId: string) {
  const mov = await prisma.bankMovement.findFirst({ where: { id: movimientoId, companyId } });
  if (!mov) throw notFound('Movimiento bancario no encontrado.');
  const movimiento = { id: mov.id, fecha: mov.fecha, importe: Number(mov.importe), concepto: mov.concepto, conciliado: mov.conciliado };
  if (mov.conciliado || Number(mov.importe) >= 0) return { movimiento, sugerencias: [] as SugerenciaPagoNominas[] };
  const cargo = aCentimos(-Number(mov.importe));
  const sugerencias: SugerenciaPagoNominas[] = [];

  const pendientes = await prisma.nomina.findMany({
    where: { companyId, estado: 'CONTABILIZADA' },
    select: { ejercicio: true, mes: true, liquido: true, embargos: true },
  });
  const porMes = new Map<string, { ejercicio: number; mes: number; liquido: number; embargos: number }>();
  for (const n of pendientes) {
    const k = `${n.ejercicio}-${n.mes}`;
    const v = porMes.get(k) ?? { ejercicio: n.ejercicio, mes: n.mes, liquido: 0, embargos: 0 };
    v.liquido += aCentimos(Number(n.liquido));
    v.embargos += aCentimos(Number(n.embargos));
    porMes.set(k, v);
  }
  for (const v of porMes.values()) {
    const accion = `POST /nominas/periodos/${v.ejercicio}/${v.mes}/pago`;
    if (v.liquido === cargo) {
      sugerencias.push({ tipo: 'liquidos', ejercicio: v.ejercicio, mes: v.mes, concepto: `Pago nóminas ${mm(v.mes)}/${v.ejercicio}`, importe: euros(v.liquido), accion });
    } else if (v.embargos && v.liquido + v.embargos === cargo) {
      sugerencias.push({
        tipo: 'liquidos',
        ejercicio: v.ejercicio,
        mes: v.mes,
        concepto: `Pago nóminas ${mm(v.mes)}/${v.ejercicio} con los embargos`,
        importe: euros(v.liquido + v.embargos),
        accion,
        incluirEmbargos: true,
      });
    }
  }

  const anio = Number(mov.fecha.slice(0, 4));
  for (const ej of [anio - 1, anio]) {
    for (const ss of await listarSegurosSociales(companyId, ej)) {
      if (ss.estado === 'PENDIENTE' && ss.aPagar && aCentimos(ss.aPagar) === cargo) {
        sugerencias.push({
          tipo: 'seguros_sociales',
          ejercicio: ss.ejercicio,
          mes: ss.mes,
          concepto: `Seguros sociales ${mm(ss.mes)}/${ss.ejercicio}`,
          importe: ss.aPagar,
          accion: `POST /nominas/seguros-sociales/${ss.ejercicio}/${ss.mes}/pago`,
        });
      }
    }
  }

  // El 111 que se paga en el mes del cargo: el del trimestre anterior.
  const trimestre = Math.ceil(Number(mov.fecha.slice(5, 7)) / 3) - 1;
  const ej111 = trimestre === 0 ? anio - 1 : anio;
  const per111 = `${trimestre === 0 ? 4 : trimestre}T`;
  if ((await esEmpresaEspanolaFiscal(companyId)) && !(await pagoModelo111(companyId, ej111, per111))) {
    const d = await importePago111(companyId, periodoFiscal(ej111, per111));
    if (aCentimos(d.total) === cargo) {
      sugerencias.push({
        tipo: 'modelo111',
        ejercicio: ej111,
        periodo: per111,
        concepto: `Modelo 111 ${per111}/${ej111}`,
        importe: d.total,
        accion: `POST /nominas/retenciones/${ej111}/${per111}/pago`,
      });
    }
  }
  return { movimiento, sugerencias };
}

/**
 * Cargos del extracto sin conciliar por un importe exacto (el de un pago de
 * nominas, seguros sociales o 111), los mas cercanos a la fecha primero. Al
 * pagar eligiendo uno, queda conciliado con el asiento del pago.
 */
export async function cargosParaPago(companyId: string, importe: number, fecha?: string) {
  const cargo = aCentimos(importe);
  const movs = await prisma.bankMovement.findMany({
    where: { companyId, conciliado: false, importe: -cargo / 100 },
    include: { cuentaBancaria: { select: { bancoNombre: true, iban: true, subcuentaCodigo: true } } },
    orderBy: { fecha: 'desc' },
    take: 50,
  });
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '') ? new Date(`${fecha}T00:00:00Z`).getTime() : null;
  const dias = (f: string) => (ref === null ? 0 : Math.abs(new Date(`${f}T00:00:00Z`).getTime() - ref) / 86400000);
  return movs
    .filter((m) => aCentimos(-Number(m.importe)) === cargo)
    .sort((a, b) => dias(a.fecha) - dias(b.fecha) || b.fecha.localeCompare(a.fecha))
    .slice(0, 20)
    .map((m) => ({
      id: m.id,
      fecha: m.fecha,
      importe: Number(m.importe),
      concepto: m.concepto,
      cuentaBancariaId: m.cuentaBancariaId,
      cuenta: `${m.cuentaBancaria.bancoNombre ? `${m.cuentaBancaria.bancoNombre} · ` : ''}${m.cuentaBancaria.iban.replace(/\s/g, '').slice(-8)} (${m.cuentaBancaria.subcuentaCodigo})`,
    }));
}
