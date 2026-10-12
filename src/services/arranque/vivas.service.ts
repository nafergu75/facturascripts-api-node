/**
 * Datos para las comprobaciones «vivas» de A4 (las que se arreglan fuera de
 * los ficheros de la gestoria): bancos con el saldo del extracto, el 303 del
 * 4T y las cuotas a compensar, los datos de la empresa, las series de 2027,
 * el ejercicio de 2027 y, con la carga ya importada, los clientes y
 * proveedores con saldo que siguen sin ficha.
 *
 * Solo lee. El calculo de los puntos esta en comprobaciones.ts.
 */
import { prisma } from '../../config/database';
import { esNifEspanolValido, normalizarNif } from '../../utils/nif';
import { esSubcuentaDeTercero } from '../terceros/numeracion';
import { comprobarVivas, type BancoComprobar, type EntradaVivas, type PuntoComprobacion } from './comprobaciones';
import type { AjusteBanco, DatosFiscales } from './datos';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineaSaldo {
  cuenta: string;
  nombre?: string;
  debe: number;
  haber: number;
}

/** Saldo deudor por subcuenta de unas lineas de apertura. */
function saldos(lineas: LineaSaldo[]): Map<string, { saldo: number; nombre: string }> {
  const m = new Map<string, { saldo: number; nombre: string }>();
  for (const l of lineas) {
    const x = m.get(l.cuenta) ?? { saldo: 0, nombre: l.nombre ?? '' };
    x.saldo = r2(x.saldo + l.debe - l.haber);
    if (!x.nombre && l.nombre) x.nombre = l.nombre;
    m.set(l.cuenta, x);
  }
  return m;
}

/** Datos de la empresa que piden los modelos y que faltan. */
export async function datosEmpresaQueFaltan(companyId: string): Promise<string[]> {
  const l = await prisma.legalConfig.findUnique({ where: { companyId } });
  const campos: Array<[string, unknown]> = [
    ['razón social', l?.denominacion],
    ['NIF', l?.nif],
    ['domicilio', l?.domicilioSocial],
    ['código postal', l?.codigoPostal],
    ['municipio', l?.municipio],
    ['provincia', l?.provincia],
    ['teléfono', l?.telefono],
    ['persona de contacto', l?.personaContacto],
    ['clave de actividad', l?.claveActividad],
    ['epígrafe del IAE', l?.epigrafeIae],
  ];
  return campos.filter(([, v]) => !String(v ?? '').trim()).map(([n]) => n);
}

/** Series de factura y rectificativa: tipos sin activa y predeterminada, y las predeterminadas ya usadas antes. */
export async function estadoSeries(companyId: string, anioAnterior: number): Promise<EntradaVivas['series']> {
  const series = await prisma.invoiceSeries.findMany({ where: { companyId, tipoDocumento: { in: ['FACTURA', 'RECTIFICATIVA'] } } });
  const faltan: string[] = [];
  const usadasAntes: string[] = [];
  for (const [tipo, nombre] of [
    ['FACTURA', 'facturas'],
    ['RECTIFICATIVA', 'rectificativas'],
  ] as const) {
    const suyas = series.filter((s) => s.tipoDocumento === tipo);
    // Sin ninguna, la app crea las suyas al abrir la facturacion (A y R).
    if (!suyas.length) continue;
    const buena = suyas.find((s) => s.activa && s.porDefecto);
    if (!buena) faltan.push(nombre);
    else if (buena.ultimaFecha && buena.ultimaFecha <= `${anioAnterior}-12-31`) usadasAntes.push(buena.codigo);
  }
  return { faltan, usadasAntes };
}

/** Bancos (572) de la apertura con su extracto y su cuenta de Tesoreria. */
async function bancosDe(companyId: string, apertura: Map<string, { saldo: number; nombre: string }>, ajustes: Record<string, AjusteBanco>): Promise<BancoComprobar[]> {
  const codigos = [...apertura.keys()].filter((c) => c.startsWith('572')).sort();
  if (!codigos.length) return [];
  const cuentas = await prisma.bankAccount.findMany({ where: { companyId }, select: { id: true, iban: true, subcuentaCodigo: true, activa: true } });
  return codigos.map((codigo) => {
    const a = ajustes[codigo];
    const elegida = a?.bankAccountId ? cuentas.find((c) => c.id === a.bankAccountId) : cuentas.find((c) => c.subcuentaCodigo === codigo && c.activa);
    return {
      subcuenta: codigo,
      nombre: apertura.get(codigo)!.nombre,
      saldoApertura: apertura.get(codigo)!.saldo,
      saldoExtracto: a?.saldoExtracto ?? null,
      cuenta: a?.nueva?.iban ?? elegida?.iban ?? null,
      aceptada: !!a?.aceptarDiferencia,
    };
  });
}

/** Subcuentas de clientes y proveedores con saldo en la apertura que no son de una ficha con NIF valido. */
async function tercerosSinFicha(companyId: string, apertura: Map<string, { saldo: number; nombre: string }>) {
  const codigos = [...apertura.entries()].filter(([c, x]) => esSubcuentaDeTercero(c) && Math.round(x.saldo * 100) !== 0).map(([c]) => c);
  if (!codigos.length) return [];
  const [clientes, proveedores] = await Promise.all([
    prisma.customer.findMany({ where: { companyId, subcuenta430: { in: codigos } }, select: { subcuenta430: true, nifCif: true, pais: true } }),
    prisma.supplier.findMany({
      where: { companyId, OR: [{ subcuenta400: { in: codigos } }, { subcuenta410: { in: codigos } }] },
      select: { subcuenta400: true, subcuenta410: true, nifCif: true, pais: true },
    }),
  ]);
  const valido = (nif: string | null, pais: string | null) => !!normalizarNif(nif) && (String(pais ?? 'ES').toUpperCase() !== 'ES' || esNifEspanolValido(nif));
  const conFicha = new Set<string>();
  for (const c of clientes) if (c.subcuenta430 && valido(c.nifCif, c.pais)) conFicha.add(c.subcuenta430);
  for (const p of proveedores) {
    if (!valido(p.nifCif, p.pais)) continue;
    if (p.subcuenta400) conFicha.add(p.subcuenta400);
    if (p.subcuenta410) conFicha.add(p.subcuenta410);
  }
  return codigos.filter((c) => !conFicha.has(c)).map((codigo) => ({ codigo, nombre: apertura.get(codigo)!.nombre }));
}

export interface FuenteVivas {
  /** Lineas de la apertura (del analisis o del asiento ya grabado); null sin apertura. */
  apertura: LineaSaldo[] | null;
  bancos: Record<string, AjusteBanco>;
  datosFiscales: DatosFiscales;
  /** true con la carga ya importada: se mira el ejercicio y los terceros sin ficha. */
  importada: boolean;
}

/** Puntos vivos de A4 para un ejercicio de destino, con los bancos de la apertura. */
export async function puntosVivos(companyId: string, ejercicio: number, f: FuenteVivas): Promise<{ puntos: PuntoComprobacion[]; bancos: BancoComprobar[] | null }> {
  const anio = ejercicio - 1;
  const apertura = f.apertura ? saldos(f.apertura) : null;
  const suma = (re: RegExp) => (apertura ? r2([...apertura.entries()].filter(([c]) => re.test(c)).reduce((s, [, x]) => s + x.saldo, 0)) : 0);
  const [empresaFaltan, series, fy, bancos, sinFicha] = await Promise.all([
    datosEmpresaQueFaltan(companyId),
    estadoSeries(companyId, anio),
    f.importada ? prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) }, select: { id: true } }) : Promise.resolve(null),
    apertura ? bancosDe(companyId, apertura, f.bancos) : Promise.resolve(null),
    f.importada && apertura ? tercerosSinFicha(companyId, apertura) : Promise.resolve(undefined),
  ]);
  const puntos = comprobarVivas({
    ejercicioOrigen: anio,
    bancos,
    iva: apertura
      ? {
          saldo4750: -suma(/^4750/),
          saldo4700: suma(/^4700/),
          resultado303: f.datosFiscales.resultado303T4 ?? null,
          cuotasACompensar: f.datosFiscales.cuotasIvaACompensar ?? null,
        }
      : null,
    empresaFaltan,
    series,
    ejercicioCreado: f.importada ? !!fy : null,
    ...(sinFicha ? { tercerosSinFicha: sinFicha } : {}),
  });
  return { puntos, bancos };
}
