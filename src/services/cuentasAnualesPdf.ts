import type { FilaPdf } from '../utils/pdf-a';
import type { CuentasAnualesRM } from '../domain/cuentas-anuales.model';
import type { BalancePartida } from '../domain/impuesto-sociedades.model';
import type { ModeloCuentas } from '../domain/registroMercantil.model';
import type { Memoria } from './memoria.service';

/** 1234.5 -> '1.234,50' (con punto de miles tambien en las de 4 cifras). */
function formatear(n: number): string {
  const [entera, decimales] = n.toFixed(2).split('.');
  return `${entera.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${decimales}`;
}

/** Importe al estilo de los modelos oficiales: negativos entre parentesis. */
export function importe(n: number): string {
  if (Math.abs(n) < 0.005) return '0,00';
  return n < 0 ? `(${formatear(-n)})` : formatear(n);
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** 'B.III.3' -> 'III.3', 'A1.VII' -> 'VII', 'A2' -> 'A-2)'. */
function etiqueta(codigo = ''): string {
  const partes = codigo.split('.');
  return partes.length > 1 ? `${partes.slice(1).join('.')}.` : `${codigo.replace(/^([A-Z])(\d)$/, '$1-$2')})`;
}

const NOMBRE_CORTO_PN: Record<string, string> = {
  'A1.I': 'Capital',
  'A1.II': 'Prima de emisión',
  'A1.III': 'Reservas',
  'A1.IV': 'Acciones propias',
  'A1.V': 'Result. ej. anteriores',
  'A1.VI': 'Aportaciones socios',
  'A1.VII': 'Resultado ejercicio',
  'A1.VIII': 'Dividendo a cuenta',
  A2: 'Subvenciones',
};

function seccion(titulo: string, cabeceras: string[], nuevaPagina = true): FilaPdf[] {
  return [
    ...(nuevaPagina ? [] : [{ texto: '' }, { texto: '' }]),
    { texto: titulo, nuevaPagina },
    { texto: '' },
    { texto: '', columnas: cabeceras },
  ];
}

/**
 * Contenido del PDF de las cuentas anuales: portada, balance, cuenta de
 * perdidas y ganancias, estado de cambios en el patrimonio neto, estado de
 * flujos de efectivo y propuesta de aplicacion del resultado, con la columna
 * del ejercicio anterior. La memoria se añade aparte.
 */
export function filasCuentasAnuales(ca: CuentasAnualesRM, modelo: ModeloCuentas): FilaPdf[] {
  const n = String(ca.sociedad.ejercicio);
  const n1 = String(ca.sociedad.ejercicio - 1);
  const ant = (lista: BalancePartida[] | undefined, codigo?: string) =>
    lista?.find((p) => p.codigo === codigo)?.importe ?? 0;

  const filas: FilaPdf[] = [
    { texto: `Denominación social: ${ca.sociedad.denominacion || '(sin indicar)'}` },
    { texto: `NIF: ${ca.sociedad.nif || '(sin indicar)'}` },
    { texto: `Forma jurídica: ${ca.sociedad.formaJuridica || '(sin indicar)'}` },
    { texto: `Domicilio social: ${ca.sociedad.domicilio || '(sin indicar)'}` },
    { texto: `Ejercicio: 01/01/${n} a 31/12/${n}` },
    { texto: `Modelo: ${modelo === 'PYME' ? 'PYMES' : modelo === 'ABREVIADO' ? 'Abreviado' : 'Normal'}` },
    { texto: 'Importes en euros.' },
    { texto: '' },
  ];

  if (modelo === 'NORMAL') {
    filas.push({ texto: 'Aviso: los estados se presentan con la estructura del modelo PYMES; el modelo normal pide más desglose.' });
  }
  if ((ca.balance.descuadre ?? 0) !== 0) {
    filas.push({ texto: `AVISO: el balance no cuadra (diferencia ${importe(ca.balance.descuadre ?? 0)}). Revisa los asientos antes de presentar.` });
  }
  filas.push({ texto: 'Documento generado a partir de la contabilidad. Lo formulan los administradores y lo aprueba la junta.' });

  // --- Balance ---
  const b = ca.balance;
  const ba = ca.anterior?.balance;
  filas.push(...seccion(`BALANCE AL 31/12/${n}`, [n, n1]));
  const bloque = (titulo: string, actual: BalancePartida[], anterior: BalancePartida[] | undefined) => {
    const total = round2(actual.reduce((s, p) => s + p.importe, 0));
    const totalAnt = round2((anterior ?? []).reduce((s, p) => s + p.importe, 0));
    filas.push({ texto: titulo, columnas: [importe(total), importe(totalAnt)] });
    for (const p of actual) {
      const pa = ant(anterior, p.codigo);
      if (p.importe === 0 && pa === 0) continue;
      filas.push({ texto: `${etiqueta(p.codigo)} ${p.descripcion}`, sangria: 1, columnas: [importe(p.importe), importe(pa)] });
    }
  };
  bloque('A) ACTIVO NO CORRIENTE', b.activoNoCorriente, ba?.activoNoCorriente);
  bloque('B) ACTIVO CORRIENTE', b.activoCorriente, ba?.activoCorriente);
  filas.push({ texto: 'TOTAL ACTIVO (A + B)', separador: true, columnas: [importe(b.totalActivo), importe(ba?.totalActivo ?? 0)] });
  filas.push({ texto: '' });
  bloque('A) PATRIMONIO NETO', b.patrimonioNeto, ba?.patrimonioNeto);
  bloque('B) PASIVO NO CORRIENTE', b.pasivoNoCorriente, ba?.pasivoNoCorriente);
  bloque('C) PASIVO CORRIENTE', b.pasivoCorriente, ba?.pasivoCorriente);
  filas.push({
    texto: 'TOTAL PATRIMONIO NETO Y PASIVO (A + B + C)',
    separador: true,
    columnas: [importe(b.totalPatrimonioNetoYPasivo), importe(ba?.totalPatrimonioNetoYPasivo ?? 0)],
  });

  // --- Cuenta de perdidas y ganancias ---
  const pyg = ca.pyg;
  const pa = ca.anterior?.pyg;
  filas.push(...seccion(`CUENTA DE PÉRDIDAS Y GANANCIAS DEL EJERCICIO ${n}`, [n, n1]));
  const partidaPyg = (codigo: string) => {
    const p = pyg.partidas?.find((x) => x.codigo === codigo);
    const valorAnt = ant(pa?.partidas, codigo);
    if (!p || (p.importe === 0 && valorAnt === 0)) return;
    filas.push({ texto: `${codigo}. ${p.descripcion}`, sangria: 1, columnas: [importe(p.importe), importe(valorAnt)] });
  };
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].forEach(partidaPyg);
  filas.push({ texto: 'A) RESULTADO DE EXPLOTACIÓN', separador: true, columnas: [importe(pyg.resultadoExplotacion), importe(pa?.resultadoExplotacion ?? 0)] });
  ['13', '14', '15', '16', '17'].forEach(partidaPyg);
  filas.push({ texto: 'B) RESULTADO FINANCIERO', separador: true, columnas: [importe(pyg.resultadoFinanciero), importe(pa?.resultadoFinanciero ?? 0)] });
  filas.push({ texto: 'C) RESULTADO ANTES DE IMPUESTOS (A + B)', columnas: [importe(pyg.resultadoAntesImpuestos), importe(pa?.resultadoAntesImpuestos ?? 0)] });
  partidaPyg('18');
  filas.push({ texto: 'D) RESULTADO DEL EJERCICIO (C + 18)', separador: true, columnas: [importe(pyg.resultadoEjercicio), importe(pa?.resultadoEjercicio ?? 0)] });

  // --- ECPN ---
  filas.push(...seccion(`ESTADO DE CAMBIOS EN EL PATRIMONIO NETO DEL EJERCICIO ${n}`, ['Saldo inicial', 'Resultado', 'Socios', 'Otras', 'Saldo final']));
  const comps = (ca.ecpn.componentes ?? []).filter(
    (c) => c.saldoInicial !== 0 || c.saldoFinal !== 0 || c.resultadoEjercicio !== 0,
  );
  for (const c of comps) {
    filas.push({
      texto: NOMBRE_CORTO_PN[c.codigo] ?? c.descripcion,
      columnas: [
        importe(c.saldoInicial),
        importe(c.resultadoEjercicio),
        importe(c.operacionesSocios),
        importe(round2(c.otrasVariaciones + c.ingresosGastosReconocidos)),
        importe(c.saldoFinal),
      ],
    });
  }
  const sum = (f: (c: (typeof comps)[number]) => number) => importe(round2(comps.reduce((s, c) => s + f(c), 0)));
  filas.push({
    texto: 'TOTAL',
    separador: true,
    columnas: [
      sum((c) => c.saldoInicial),
      sum((c) => c.resultadoEjercicio),
      sum((c) => c.operacionesSocios),
      sum((c) => c.otrasVariaciones + c.ingresosGastosReconocidos),
      sum((c) => c.saldoFinal),
    ],
  });
  filas.push({ texto: '' });
  filas.push({ texto: '"Otras" recoge sobre todo la aplicación del resultado del ejercicio anterior y las subvenciones.' });

  // --- EFE (obligatorio solo en el modelo normal; se incluye siempre como informacion) ---
  if (ca.efe) {
    const e = ca.efe;
    filas.push(...seccion(`ESTADO DE FLUJOS DE EFECTIVO DEL EJERCICIO ${n}`, [n]));
    for (const s of [e.flujosExplotacion, e.flujosInversion, e.flujosFinanciacion]) {
      filas.push({ texto: s.titulo, columnas: [importe(s.subtotal)] });
      for (const p of s.partidas) filas.push({ texto: p.descripcion, sangria: 1, columnas: [importe(p.importe)] });
    }
    filas.push({ texto: 'Aumento / disminución neta del efectivo', separador: true, columnas: [importe(e.variacionNetaEfectivo)] });
    filas.push({ texto: 'Efectivo al comienzo del ejercicio', columnas: [importe(e.efectivoInicial)] });
    filas.push({ texto: 'Efectivo al final del ejercicio', columnas: [importe(e.efectivoFinal)] });
    if (modelo !== 'NORMAL') filas.push({ texto: 'En los modelos PYMES y abreviado este estado es voluntario.' });
  }

  // --- Aplicacion del resultado ---
  const ap = ca.aplicacionResultado;
  filas.push(...seccion('PROPUESTA DE APLICACIÓN DEL RESULTADO', ['Importe'], false));
  filas.push({ texto: 'Base de reparto: resultado del ejercicio', columnas: [importe(ap.resultadoEjercicio)] });
  if (ap.resultadoEjercicio > 0) {
    filas.push({ texto: 'A reserva legal', sangria: 1, columnas: [importe(ap.aReservaLegal)] });
    filas.push({ texto: 'A reservas voluntarias', sangria: 1, columnas: [importe(ap.aReservasVoluntarias)] });
    if (ap.aDividendos) filas.push({ texto: 'A dividendos', sangria: 1, columnas: [importe(ap.aDividendos)] });
  } else if (ap.resultadoEjercicio < 0) {
    filas.push({ texto: 'A resultados negativos de ejercicios anteriores', sangria: 1, columnas: [importe(-ap.aCompensacionPerdidas)] });
  }
  filas.push({ texto: 'Propuesta automática (10% a reserva legal hasta el 20% del capital). La decide la junta.' });

  return filas;
}

/**
 * Memoria: cada nota con sus parrafos (partidos en lineas que caben en la
 * pagina) y sus tablas. Al final, la lista de lo que falta por completar.
 */
export function filasMemoria(memoria: Memoria, ejercicio: number): FilaPdf[] {
  const filas: FilaPdf[] = [{ texto: `MEMORIA DEL EJERCICIO ${ejercicio}`, nuevaPagina: true }, { texto: '' }];
  for (const nota of memoria.notas) {
    filas.push({ texto: `${nota.numero}. ${nota.titulo.toUpperCase()}` });
    for (const p of nota.parrafos) {
      for (const linea of partirTexto(p, 105)) filas.push({ texto: linea });
      filas.push({ texto: '' });
    }
    for (const t of nota.tablas) {
      filas.push({ texto: t.cabeceras[0], columnas: t.cabeceras.slice(1) });
      for (const f of t.filas) {
        filas.push({ texto: f.texto, sangria: f.total ? 0 : 1, separador: f.total, columnas: f.valores.map(importe) });
      }
      filas.push({ texto: '' });
    }
    filas.push({ texto: '' });
  }
  if (memoria.pendientes.length) {
    filas.push({ texto: 'DATOS PENDIENTES DE COMPLETAR ANTES DE PRESENTAR', nuevaPagina: true }, { texto: '' });
    for (const p of memoria.pendientes) filas.push({ texto: `- ${p}` });
  }
  return filas;
}

/** Parte un texto en lineas de como mucho `max` caracteres, por palabras. */
export function partirTexto(texto: string, max: number): string[] {
  const lineas: string[] = [];
  let actual = '';
  for (const palabra of texto.split(/\s+/)) {
    if (actual && (actual + ' ' + palabra).length > max) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = actual ? `${actual} ${palabra}` : palabra;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}
