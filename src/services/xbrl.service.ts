// Informe XBRL del balance y la cuenta de perdidas y ganancias para importar en
// el programa D2 del Colegio de Registradores (deposito de cuentas).
//
// Taxonomia PGC2007 v1.6.0 del ICAC (vigente para ejercicios desde 2021), modelos
// PYMES y abreviado: comparten los conceptos, el abreviado añade tres partidas de
// balance y una de PyG. Los nombres de los elementos salen del enlace de
// presentacion de la taxonomia; NO inventar nombres: uno mal escrito hace que D2
// rechace el fichero.
//
// Signos: como en los modelos del Registro, los gastos van en negativo (criterio
// de la taxonomia, Descripcion-PGC2007 §8). Importes con centimos (decimals=2):
// los totales son sumas exactas de sus desgloses.
import type { SaldosEjercicio } from './contabilidadDatos.service';
import { calcularBalanceModelo, calcularPyGModelo, partidaBalance } from '../domain/modelos-cuentas-anuales';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type ModeloXbrl = 'PYME' | 'ABREVIADO';

const VERSION = '2022-01-01';
const NS: Record<string, string> = {
  'pgc-07-c-bs': `http://www.icac.meh.es/es/fr/gaap/pgc07/comun-base/${VERSION}`,
  'pgc-07-c-ap': `http://www.icac.meh.es/es/fr/gaap/pgc07/comun-abreviadopymes/${VERSION}`,
  'pgc-07-c-na': `http://www.icac.meh.es/es/fr/gaap/pgc07/comun-normalabreviado/${VERSION}`,
};
const ESQUEMA: Record<ModeloXbrl, string> = {
  PYME: 'https://www.icac.gob.es/sites/default/files/pgc2007/v160/pgc07-pymes-completo.xsd',
  ABREVIADO: 'https://www.icac.gob.es/sites/default/files/pgc2007/v160/pgc07-abreviado-completo.xsd',
};

const BS = 'pgc-07-c-bs:';
const AP = 'pgc-07-c-ap:';
const NA = 'pgc-07-c-na:';

/** Partida del balance (modelos-cuentas-anuales) -> elemento de la taxonomia. */
const ELEMENTO_PARTIDA: Record<string, string> = {
  'A.I': `${BS}ActivoNoCorrienteInmovilizadoIntangible`,
  'A.II': `${BS}ActivoNoCorrienteInmovilizadoMaterial`,
  'A.III': `${BS}ActivoNoCorrienteInversionesInmobiliarias`,
  'A.IV': `${BS}ActivoNoCorrienteInversionesEmpresasGrupoEmpresasAsociadasLargoPlazo`,
  'A.V': `${BS}ActivoNoCorrienteInversionesFinancierasLargoPlazo`,
  'A.VI': `${BS}ActivoNoCorrienteActivosImpuestoDiferido`,
  'B.I': `${NA}ActivoCorrienteActivosNoCorrientesMantenidosParaVenta`, // solo abreviado
  'B.II': `${BS}ActivoCorrienteExistencias`,
  'B.III.1': `${BS}ActivoCorrienteDeudoresComercialesOtrasCuentasCobrarClientesVentasPrestacionesServicios`,
  'B.III.2': `${BS}ActivoCorrienteDeudoresComercialesOtrasCuentasCobrarAccionistasDesembolsosExigidos`,
  'B.III.3': `${AP}ActivoCorrienteDeudoresComercialesOtrasCuentasCobrarOtrosDeudores`,
  'B.IV': `${BS}ActivoCorrienteInversionesEmpresasGrupoEmpresasAsociadasCortoPlazo`,
  'B.V': `${BS}ActivoCorrienteInversionesFinancierasCortoPlazo`,
  'B.VI': `${BS}ActivoCorrientePeriodificacionesCortoPlazo`,
  'B.VII': `${BS}ActivoCorrienteEfectivoOtrosActivosLiquidosEquivalentes`,
  'A1.I': `${BS}PatrimonioNetoFondosPropiosCapital`,
  'A1.II': `${BS}PatrimonioNetoFondosPropiosPrimaEmision`,
  'A1.III': `${BS}PatrimonioNetoFondosPropiosReservas`,
  'A1.IV': `${BS}PatrimonioNetoFondosPropiosAccionesParticipacionesPatrimonioPropias`,
  'A1.V': `${BS}PatrimonioNetoFondosPropiosResultadosEjerciciosAnteriores`,
  'A1.VI': `${BS}PatrimonioNetoFondosPropiosOtrasAportacionesSocios`,
  'A1.VII': `${BS}PatrimonioNetoFondosPropiosResultadoEjercicio`,
  'A1.VIII': `${BS}PatrimonioNetoFondosPropiosDividendoCuenta`,
  'C.I': `${BS}PasivoNoCorrienteProvisionesLargoPlazo`,
  'C.II': `${BS}PasivoNoCorrienteDeudasLargoPlazo`,
  'C.III': `${BS}PasivoNoCorrienteDeudasEmpresasGrupoEmpresasAsociadasLargoPlazo`,
  'C.IV': `${BS}PasivoNoCorrientePasivosImpuestoDiferido`,
  'C.V': `${BS}PasivoNoCorrientePeriodificacionesLargoPlazo`,
  'D.I': `${BS}PasivoCorrienteProvisionesCortoPlazo`,
  'D.II': `${BS}PasivoCorrienteDeudasCortoPlazo`,
  'D.III': `${BS}PasivoCorrienteDeudasEmpresasGrupoEmpresasAsociadas`,
  'D.IV.1': `${BS}PasivoCorrienteAcreedoresComercialesOtrasCuentasPagarProveedores`,
  'D.IV.2': `${AP}PasivoCorrienteAcreedoresComercialesOtrasCuentasPagarOtrosAcreedores`,
  'D.V': `${BS}PasivoCorrientePeriodificacionesCortoPlazo`,
};

/** Partida de PyG (1-18) -> elemento de la taxonomia. */
const ELEMENTO_PYG: Record<string, string> = {
  '1': `${BS}PerdidasGananciasOperacionesContinuadasImporteNetoCifraNegocios`,
  '2': `${BS}PerdidasGananciasOperacionesContinuadasVariacionExistenciasProductosTerminadosProductosCursoFabricacion`,
  '3': `${BS}PerdidasGananciasOperacionesContinuadasTrabajosRealizadosEmpresaActivo`,
  '4': `${BS}PerdidasGananciasOperacionesContinuadasAprovisionamientos`,
  '5': `${BS}PerdidasGananciasOperacionesContinuadasOtrosIngresosExplotacion`,
  '6': `${BS}PerdidasGananciasOperacionesContinuadasGestionPersonal`,
  '7': `${BS}PerdidasGananciasOperacionesContinuadasOtrosGastosExplotacion`,
  '8': `${BS}PerdidasGananciasOperacionesContinuadasAmortizacionInmovilizado`,
  '9': `${BS}PerdidasGananciasOperacionesContinuadasImputacionSubvencionesInmovilizadoNoFinancieroOtras`,
  '10': `${BS}PerdidasGananciasOperacionesContinuadasExcesosProvisiones`,
  '11': `${BS}PerdidasGananciasOperacionesContinuadasDeterioroResultadoEnajenacionesInmovilizado`,
  '12': `${BS}PerdidasGananciasOtrosResultados`,
  '13': `${BS}PerdidasGananciasOperacionesContinuadasIngresosFinancieros`,
  '14': `${BS}PerdidasGananciasOperacionesContinuadasGastosFinancieros`,
  '15': `${BS}PerdidasGananciasOperacionesContinuadasVariacionValorRazonableInstrumentosFinancieros`,
  '16': `${BS}PerdidasGananciasOperacionesContinuadasDiferenciasCambio`,
  '17': `${BS}PerdidasGananciasOperacionesContinuadasDeterioroResultadoEnajenacionesInstrumentosFinancieros`,
  '18': `${BS}PerdidasGananciasOperacionesContinuadasImpuestosSobreBeneficios`,
};

export interface HechosXbrl {
  balance: Map<string, number>;
  pyg: Map<string, number>;
  avisos: string[];
}

/**
 * Hechos (elemento -> importe) del balance y la PyG de un ejercicio. Los
 * desgloses que pide la taxonomia (capital escriturado/no exigido, deudas con
 * entidades de credito, arrendamiento financiero...) salen de las cuentas.
 */
export function hechosXbrl(saldos: SaldosEjercicio, modelo: ModeloXbrl): HechosXbrl {
  const avisos: string[] = [];
  const pygModelo = calcularPyGModelo(saldos.pyg);
  const bal = calcularBalanceModelo(saldos.balance, pygModelo.resultadoEjercicio, saldos.resultadoAnteriores);
  const partida = (c: string) => bal.partidas.find((p) => p.codigo === c)?.importe ?? 0;

  // Desgloses por cuenta, en el signo natural de su partida.
  const desglose = new Map<string, number>();
  const sumar = (k: string, v: number) => desglose.set(k, round2((desglose.get(k) ?? 0) + v));
  for (const [cuenta, saldo] of saldos.balance) {
    if (saldo === 0) continue;
    const { partida: p, importe } = partidaBalance(cuenta, saldo);
    if (p === 'A1.I') sumar(/^10[34]/.test(cuenta) ? 'capitalNoExigido' : 'capitalEscriturado', importe);
    if (p === 'C.II') sumar(cuenta.startsWith('170') ? 'lpBancos' : cuenta.startsWith('174') ? 'lpArrendamiento' : 'lpOtras', importe);
    if (p === 'D.II') {
      sumar(/^(520|527|57)/.test(cuenta) ? 'cpBancos' : cuenta.startsWith('524') ? 'cpArrendamiento' : 'cpOtras', importe);
    }
    if (p === 'A2') sumar(/^13[3-7]/.test(cuenta) ? 'ajustesValor' : 'subvenciones', importe);
  }
  const d = (k: string) => desglose.get(k) ?? 0;

  const b = new Map<string, number>();
  const poner = (m: Map<string, number>, k: string, v: number) => m.set(k, round2(v));

  // Activo
  let mantenidosVenta = partida('B.I');
  if (modelo === 'PYME' && mantenidosVenta !== 0) {
    // El modelo PYMES no tiene esta partida: se presenta con las inversiones a corto.
    avisos.push('Activos no corrientes mantenidos para la venta (58) incluidos en inversiones financieras a corto plazo: el modelo PYMES no tiene esa partida.');
  }
  for (const c of ['A.I', 'A.II', 'A.III', 'A.IV', 'A.V', 'A.VI', 'B.II', 'B.III.1', 'B.III.2', 'B.III.3', 'B.IV', 'B.VI', 'B.VII']) {
    poner(b, ELEMENTO_PARTIDA[c], partida(c));
  }
  if (modelo === 'PYME') {
    poner(b, ELEMENTO_PARTIDA['B.V'], partida('B.V') + mantenidosVenta);
    mantenidosVenta = 0;
  } else {
    poner(b, ELEMENTO_PARTIDA['B.V'], partida('B.V'));
    poner(b, ELEMENTO_PARTIDA['B.I'], mantenidosVenta);
  }
  poner(b, `${BS}ActivoCorrienteDeudoresComercialesOtrasCuentasCobrarClientesVentasPrestacionesServiciosCortoPlazo`, partida('B.III.1'));
  poner(b, `${BS}ActivoCorrienteDeudoresComercialesOtrasCuentasCobrar`, partida('B.III.1') + partida('B.III.2') + partida('B.III.3'));
  poner(b, `${BS}ActivoNoCorriente`, bal.totales.ANC);
  poner(b, `${BS}ActivoCorriente`, bal.totales.AC);
  poner(b, `${BS}TotalActivo`, bal.totalActivo);

  // Patrimonio neto
  for (const c of ['A1.I', 'A1.II', 'A1.III', 'A1.IV', 'A1.V', 'A1.VI', 'A1.VII', 'A1.VIII']) poner(b, ELEMENTO_PARTIDA[c], partida(c));
  poner(b, `${BS}PatrimonioNetoFondosPropiosCapitalEscriturado`, d('capitalEscriturado'));
  poner(b, `${BS}PatrimonioNetoFondosPropiosCapitalNoExigido`, d('capitalNoExigido'));
  poner(b, `${AP}PatrimonioNetoFondosPropiosReservasOtrasReservas`, partida('A1.III'));
  const fondosPropios = ['A1.I', 'A1.II', 'A1.III', 'A1.IV', 'A1.V', 'A1.VI', 'A1.VII', 'A1.VIII'].reduce((t, c) => t + partida(c), 0);
  poner(b, `${BS}PatrimonioNetoFondosPropios`, fondosPropios);
  poner(b, `${BS}PatrimonioNetoAjustesCambioValor`, d('ajustesValor'));
  poner(b, `${BS}PatrimonioNetoSubvencionesDonacionesLegadosRecibidos`, d('subvenciones'));
  poner(b, `${BS}PatrimonioNeto`, bal.totales.PN);

  // Pasivo
  for (const c of ['C.I', 'C.II', 'C.III', 'C.IV', 'C.V', 'D.I', 'D.II', 'D.III', 'D.IV.1', 'D.IV.2', 'D.V']) poner(b, ELEMENTO_PARTIDA[c], partida(c));
  poner(b, `${BS}PasivoNoCorrienteDeudasLargoPlazoDeudasEntidadesCredito`, d('lpBancos'));
  poner(b, `${BS}PasivoNoCorrienteDeudasLargoPlazoAcreedoresArrendamientoFinanciero`, d('lpArrendamiento'));
  poner(b, `${AP}PasivoNoCorrienteDeudasLargoPlazoOtrasDeudas`, d('lpOtras'));
  poner(b, `${BS}PasivoCorrienteDeudasCortoPlazoDeudasEntidadesCredito`, d('cpBancos'));
  poner(b, `${BS}PasivoCorrienteDeudasCortoPlazoAcreedoresArrendamientoFinanciero`, d('cpArrendamiento'));
  poner(b, `${AP}PasivoCorrienteDeudasCortoPlazoOtrasDeudas`, d('cpOtras'));
  poner(b, `${BS}PasivoCorrienteAcreedoresComercialesOtrasCuentasPagarProveedoresCortoPlazo`, partida('D.IV.1'));
  poner(b, `${BS}PasivoCorrienteAcreedoresComercialesOtrasCuentasPagar`, partida('D.IV.1') + partida('D.IV.2'));
  poner(b, `${BS}PasivoNoCorriente`, bal.totales.PNC);
  poner(b, `${BS}PasivoCorriente`, bal.totales.PC);
  poner(b, `${BS}PatrimonioNetoPasivoTotal`, bal.totalPatrimonioNetoYPasivo);
  poner(b, `${BS}BalanceSituacionVariable`, bal.descuadre);
  if (bal.descuadre !== 0) avisos.push(`El balance no cuadra (diferencia ${bal.descuadre}). D2 lo rechazará.`);

  // Cuenta de perdidas y ganancias
  const p = new Map<string, number>();
  const pp = (c: string) => pygModelo.partidas.find((x) => x.codigo === c)?.importe ?? 0;
  for (const [c, el] of Object.entries(ELEMENTO_PYG)) poner(p, el, pp(c));
  poner(p, `${AP}PerdidasGananciasOperacionesContinuadasIngresosFinancierosOtrosIngresosFinancieros`, pp('13'));
  poner(p, `${BS}PerdidasGananciasResultadoExplotacion`, pygModelo.resultadoExplotacion);
  poner(p, `${BS}PerdidasGananciasResultadoFinanciero`, pygModelo.resultadoFinanciero);
  poner(p, `${BS}PerdidasGananciasResultadoAntesImpuestos`, pygModelo.resultadoAntesImpuestos);
  poner(p, `${BS}PerdidasGananciasResultadoEjercicio`, pygModelo.resultadoEjercicio);

  return { balance: b, pyg: p, avisos };
}

function escaparXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface EntradaXbrl {
  modelo: ModeloXbrl;
  ejercicio: number;
  nif: string;
  saldos: SaldosEjercicio;
  saldosAnterior: SaldosEjercicio;
}

/** Instancia XBRL con el ejercicio y el anterior (columnas N y N-1). */
export function generarXbrl(e: EntradaXbrl): { xml: string; avisos: string[] } {
  const n = e.ejercicio;
  const actual = hechosXbrl(e.saldos, e.modelo);
  const anterior = hechosXbrl(e.saldosAnterior, e.modelo);
  const id = escaparXml(e.nif || 'SIN-NIF');

  const contexto = (cid: string, periodo: string) => `  <xbrli:context id="${cid}">
    <xbrli:entity>
      <xbrli:identifier scheme="urn:es:nif">${id}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
${periodo}
    </xbrli:period>
  </xbrli:context>`;
  const instante = (anio: number) => `      <xbrli:instant>${anio}-12-31</xbrli:instant>`;
  const duracion = (anio: number) => `      <xbrli:startDate>${anio}-01-01</xbrli:startDate>
      <xbrli:endDate>${anio}-12-31</xbrli:endDate>`;

  const hechos: string[] = [];
  const emitir = (m: Map<string, number>, ctx: string) => {
    for (const [el, v] of m) {
      hechos.push(`  <${el} decimals="2" contextRef="${ctx}" unitRef="euro">${v.toFixed(2)}</${el}>`);
    }
  };
  emitir(actual.balance, `Y${n}_Balance`);
  emitir(anterior.balance, `Y${n - 1}_Balance`);
  emitir(actual.pyg, `Y${n}_PYG`);
  emitir(anterior.pyg, `Y${n - 1}_PYG`);

  const xmlns = Object.entries(NS)
    .map(([p, u]) => ` xmlns:${p}="${u}"`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:iso4217="http://www.xbrl.org/2003/iso4217"${xmlns}>
  <link:schemaRef xlink:type="simple" xlink:href="${ESQUEMA[e.modelo]}"/>
${contexto(`Y${n}_Balance`, instante(n))}
${contexto(`Y${n - 1}_Balance`, instante(n - 1))}
${contexto(`Y${n}_PYG`, duracion(n))}
${contexto(`Y${n - 1}_PYG`, duracion(n - 1))}
  <xbrli:unit id="euro">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>
${hechos.join('\n')}
</xbrli:xbrl>
`;
  return { xml, avisos: [...new Set([...actual.avisos, ...anterior.avisos.map((a) => `${n - 1}: ${a}`)])] };
}
