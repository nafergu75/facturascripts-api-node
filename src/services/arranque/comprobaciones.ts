/**
 * Comprobaciones de la carga (A4): si la contabilidad de 2026 esta CORRECTA,
 * si le FALTAN datos o si tiene ERRORES que impiden traerla.
 *
 *  - Todo correcto: se puede seguir con 2027 y el arranque queda completado.
 *  - Faltan datos: se puede confirmar, pero queda un aviso fijo en el panel
 *    con la lista hasta completarlo.
 *  - Errores: no se puede confirmar hasta corregir el fichero o subir el bueno.
 *
 * Un fichero complementario que no cuadra (el diario frente al sumas y saldos,
 * el inmovilizado frente a la 2xx/28x) es un fallo solo de ese fichero: la
 * carga sigue sin el y queda como «Faltan datos» (decision D2 del usuario).
 * La facturacion de 2027 nunca se bloquea por esto.
 *
 * Funcion pura: recibe lo que ha calculado el analisis.
 */
import { aCentimos, importeTexto } from '../../utils/money';
import type { CuadreSubcuenta, ResultadoCartera } from './cartera';
import { NOMBRE_TIPO, type TipoHoja } from './clasificador';
import type { TotalesOficiales } from './extractores';
import type { AnalisisDiario } from './historico';
import type { AnalisisSaldos } from './saldos';

export type NivelPunto = 'ERROR' | 'FALTA' | 'AVISO' | 'INFO';
export type NivelCarga = 'CORRECTO' | 'FALTAN_DATOS' | 'ERRORES';

/** Fichero que se deja fuera de la carga porque no cuadra (D2). */
export type FicheroExcluido = 'DIARIO' | 'INMOVILIZADO';

export interface PuntoComprobacion {
  /** Identificador estable (para aceptar un aviso con motivo y para la pantalla). */
  clave: string;
  nivel: NivelPunto;
  texto: string;
  /** Lista de cuentas, filas o documentos afectados (como mucho 50). */
  detalle?: string[];
  /** Si el fallo deja fuera un fichero de la carga. */
  excluye?: FicheroExcluido;
}

export interface EntradaComprobaciones {
  ejercicioOrigen: number;
  tipoCarga: 'PROVISIONAL' | 'DEFINITIVA';
  presentes: Set<TipoHoja>;
  hojasConError: Array<{ fichero: string; hoja: string; mensaje: string }>;
  /** Tipos con dos hojas distintas que no se pueden juntar (dos sumas y saldos...). */
  repetidos: Array<{ tipo: TipoHoja; hojas: string[] }>;
  sumasSaldos: { analisis: AnalisisSaldos; fechaCorte: string | null } | null;
  /** Saldos sacados del diario porque no hay sumas y saldos. */
  saldosDesdeDiario: boolean;
  /** Los saldos de los que sale la apertura del 1-1 (del sumas y saldos o del diario). */
  apertura?: AnalisisSaldos | null;
  /**
   * Regularizado, sin diario que importar y sin una PyG con sus partidas: el
   * comparativo de 2026 se quedaria sin gastos ni ingresos.
   */
  comparativoSinPyg?: boolean;
  pyg: TotalesOficiales | null;
  resultadoDeclarado: number | null;
  diario: AnalisisDiario | null;
  /** Subcuentas de clientes y proveedores del plan sin NIF (para saber si hacen falta los listados). */
  tercerosSinNifEnPlan: number;
  /** Cuentas que no encajan en el PGC y tienen saldo o movimientos. */
  sinMadreConSaldo: string[];
  /** Subcuentas de clientes o proveedores con otra longitud que la del plan. */
  longitudesIncoherentes: string[];
  /** Fichero de cada grupo de subcuentas con otra longitud (para nombrarlo en el error). */
  ficherosConOtraLongitud?: Array<{ fichero: string; subcuentas: number; longitud: number }>;
  longitud: { delPlan: number | null; motivo: string | null };
  /** Subcuentas 430/400/410 con saldo que no quedaran enlazadas a una ficha con NIF valido. */
  tercerosConSaldoSinFicha: Array<{ codigo: string; nombre: string; motivo?: string }>;
  cartera: ResultadoCartera | null;
  inmovilizado: { diferencias: Array<{ codigo: string; fichas: number; saldo: number; diferencia: number }> } | null;
  /** Asientos de 2026 hechos en la app que se retiran (por origen). */
  retirados: Record<string, number>;
}

export interface ResultadoComprobaciones {
  nivel: NivelCarga;
  mensaje: string;
  puntos: PuntoComprobacion[];
  excluidos: FicheroExcluido[];
}

const eur = importeTexto;
const fechaEs = (f: string) => f.split('-').reverse().join('/');
const lista = (xs: string[]) => xs.slice(0, 50);
const varios = (n: number, uno: string, muchos: string) => `${n} ${n === 1 ? uno : muchos}`;

const NOMBRE_FICHERO: Partial<Record<TipoHoja, string>> = {
  PLAN: 'el plan de cuentas (con las subcuentas a cero y el NIF de clientes y proveedores)',
  SUMAS_Y_SALDOS: 'el sumas y saldos a 31-12-2026 por subcuenta, sin el asiento de cierre',
  TERCEROS_CLIENTES: 'el listado de clientes con su NIF',
  TERCEROS_PROVEEDORES: 'el listado de proveedores y acreedores con su NIF',
  CARTERA: 'la cartera de facturas pendientes de cobro y de pago a 31-12-2026',
  DIARIO: 'el libro diario de 2026 (para consultar 2026 en la app)',
};

export function comprobarCarga(e: EntradaComprobaciones): ResultadoComprobaciones {
  const puntos: PuntoComprobacion[] = [];
  const p = (punto: PuntoComprobacion) => puntos.push(punto);
  const anio = e.ejercicioOrigen;

  // 1. Hojas que no se han podido leer o no se sabe que son.
  for (const h of e.hojasConError) p({ clave: `hoja:${h.fichero}:${h.hoja}`, nivel: 'ERROR', texto: `${h.fichero}${h.hoja !== h.fichero ? ` › ${h.hoja}` : ''}: ${h.mensaje}` });
  for (const r of e.repetidos) {
    p({
      clave: `repetido:${r.tipo}`,
      nivel: 'ERROR',
      texto: `Hay ${r.hojas.length === 2 ? 'dos ficheros' : `${r.hojas.length} ficheros`} de ${NOMBRE_TIPO[r.tipo].toLowerCase()} distintos (${r.hojas.join(' y ')}): quita uno o marca el que no vale con «No usar esta hoja».`,
      detalle: r.hojas,
    });
  }

  // 2. Ficheros imprescindibles.
  const faltan: TipoHoja[] = [];
  if (!e.presentes.has('PLAN')) faltan.push('PLAN');
  if (!e.presentes.has('SUMAS_Y_SALDOS')) faltan.push('SUMAS_Y_SALDOS');
  // Los listados solo hacen falta si el plan no trae el NIF de todos los clientes y proveedores.
  const sinNif = !e.presentes.has('PLAN') || e.tercerosSinNifEnPlan > 0;
  if (sinNif && !e.presentes.has('TERCEROS_CLIENTES')) faltan.push('TERCEROS_CLIENTES');
  if (sinNif && !e.presentes.has('TERCEROS_PROVEEDORES')) faltan.push('TERCEROS_PROVEEDORES');
  if (!e.presentes.has('CARTERA')) faltan.push('CARTERA');
  if (!e.presentes.has('DIARIO')) faltan.push('DIARIO');
  for (const t of faltan) p({ clave: `falta:${t}`, nivel: 'FALTA', texto: `Falta ${NOMBRE_FICHERO[t]}.` });

  // 3. Sumas y saldos.
  const s = e.sumasSaldos?.analisis ?? null;
  if (e.sumasSaldos && s) {
    if (s.tipo === 'CON_CIERRE') {
      p({ clave: 'sys:cierre', nivel: 'ERROR', texto: 'El sumas y saldos tiene todas las cuentas a cero: lleva el asiento de cierre. Pide a la gestoría el sumas y saldos a 31-12-2026 sin el asiento de cierre.' });
    } else if (!s.totales.cuadra) {
      p({
        clave: 'sys:descuadre',
        nivel: 'ERROR',
        texto: `El sumas y saldos no cuadra: saldos deudores ${eur(s.totales.deudor)} y acreedores ${eur(s.totales.acreedor)} (diferencia ${eur(s.totales.diferencia)}). Falta alguna cuenta o hay un signo mal. Pide a la gestoría el listado al nivel de subcuenta, con todas las cuentas.`,
      });
    }
    const corte = e.sumasSaldos.fechaCorte;
    if (!corte) {
      p({ clave: 'sys:corte', nivel: 'AVISO', texto: `El sumas y saldos no dice a qué fecha es: se toma como el saldo a 31-12-${anio}.` });
    } else if (!corte.startsWith(`${anio}-`)) {
      p({ clave: 'sys:corte', nivel: 'ERROR', texto: `El sumas y saldos es a ${fechaEs(corte)}: tiene que ser de ${anio}.` });
    } else if (corte < `${anio}-12-31`) {
      p(
        e.tipoCarga === 'DEFINITIVA'
          ? { clave: 'sys:corte', nivel: 'ERROR', texto: `El sumas y saldos es a ${fechaEs(corte)}: el cierre definitivo tiene que ser a 31-12-${anio}.` }
          : { clave: 'sys:corte', nivel: 'AVISO', texto: `El sumas y saldos es a ${fechaEs(corte)}, no a 31-12-${anio}: vale para una carga provisional; cuando la gestoría cierre, carga el definitivo.` },
      );
    }

    if (s.tipo !== 'CON_CIERRE') {
      // Resultado frente a la PyG oficial.
      if (e.pyg?.resultado !== null && e.pyg?.resultado !== undefined) {
        const delSys = s.tipo === 'REGULARIZADO' ? s.saldo129 : s.resultadoPyg;
        if (aCentimos(delSys) !== aCentimos(e.pyg.resultado)) {
          p({
            clave: 'sys:resultado-pyg',
            nivel: 'ERROR',
            texto: `El resultado del sumas y saldos (${eur(delSys)}) no coincide con el de la cuenta de pérdidas y ganancias (${eur(e.pyg.resultado)}). Pide a la gestoría los dos listados a la misma fecha.`,
          });
        }
      } else if (s.tipo === 'REGULARIZADO') {
        p({ clave: 'falta:PYG', nivel: 'FALTA', texto: 'El sumas y saldos viene regularizado (gastos e ingresos a cero): falta la cuenta de pérdidas y ganancias de 2026 para el comparativo de 2027.' });
      }
      if (e.comparativoSinPyg && e.pyg) {
        p({
          clave: 'falta:PYG-detalle',
          nivel: 'FALTA',
          texto: `La cuenta de pérdidas y ganancias sirve para comprobar el resultado, pero no se pueden leer sus partidas (o no suman el resultado). Para la columna de ${anio} de los informes de ${anio + 1}, pide a la gestoría el sumas y saldos antes de regularizar o el libro diario.`,
        });
      }
      // Resultado que escribe la persona.
      // Si ha subido la PyG de la gestoria, su resultado ya es el declarado (y se compara arriba).
      const pygConResultado = e.pyg?.resultado !== null && e.pyg?.resultado !== undefined;
      if (e.resultadoDeclarado === null) {
        if (!pygConResultado) p({ clave: 'resultado-declarado', nivel: 'FALTA', texto: `Escribe el resultado de ${anio} que te ha dado la gestoría, para comprobar que coincide.` });
      } else if (aCentimos(e.resultadoDeclarado) !== aCentimos(s.resultado)) {
        p({
          clave: 'resultado-declarado',
          nivel: 'AVISO',
          texto: `El resultado que has escrito (${eur(e.resultadoDeclarado)}) no coincide con el del sumas y saldos (${eur(s.resultado)}). Revísalo con la gestoría antes de seguir.`,
        });
      }
      // 129 y grupos 6 y 7 a la vez.
      if (aCentimos(s.saldo129) !== 0 && aCentimos(s.resultadoPyg) !== 0) {
        if (aCentimos(s.saldo129) === aCentimos(s.resultadoPyg)) {
          p({
            clave: 'sys:regularizado-a-medias',
            nivel: 'ERROR',
            texto: `El resultado (${eur(s.resultadoPyg)}) está a la vez en la 129 y en los gastos e ingresos: el sumas y saldos parece regularizado a medias. Pide a la gestoría el listado antes de regularizar o con la regularización completa.`,
          });
        } else {
          p({
            clave: 'sys:129-antigua',
            nivel: 'AVISO',
            texto: `La 129 tiene saldo (${eur(s.saldo129)}) y además hay gastos e ingresos: parece el resultado de un año anterior sin aplicar. Conviene que la gestoría lo pase a reservas (113) o a resultados anteriores (120/121).`,
          });
        }
      }
      if (s.ivaSinLiquidar.length) {
        p({
          clave: 'iva:4t',
          nivel: 'FALTA',
          texto: 'Las cuentas de IVA soportado y repercutido (472 y 477) tienen saldo: la liquidación del IVA del 4T no está hecha. Pide a la gestoría el sumas y saldos con la liquidación del 4T.',
          detalle: lista(s.ivaSinLiquidar.map((c) => `${c.codigo} ${c.nombre}: ${eur(c.saldo)}`)),
        });
      }
      if (s.anomalias.length) {
        p({
          clave: 'sys:signos',
          nivel: 'AVISO',
          texto: `${varios(s.anomalias.length, 'cuenta tiene', 'cuentas tienen')} un saldo de signo poco habitual: revísalas.`,
          detalle: lista(s.anomalias.map((c) => `${c.codigo} ${c.nombre} (${eur(c.saldo)}): ${c.texto}`)),
        });
      }
      if (s.heredados.length) {
        p({
          clave: 'sys:heredados',
          nivel: 'INFO',
          texto: `${varios(s.heredados.length, 'cuenta se paga o se cobra', 'cuentas se pagan o se cobran')} en los primeros meses de 2027 (impuestos, sueldos...).`,
          detalle: lista(s.heredados.map((c) => `${c.codigo} ${c.nombre} (${eur(c.saldo)}): ${c.texto}`)),
        });
      }
    }
  } else if (e.saldosDesdeDiario) {
    p({ clave: 'sys:desde-diario', nivel: 'AVISO', texto: 'Sin sumas y saldos, la apertura del 1-1-2027 se calcula con los saldos del diario. Pide el sumas y saldos para comprobarlo.' });
  }

  // 3b. La apertura que se va a grabar: tiene que cuadrar siempre (si no, la fase de la
  //     apertura fallaria a mitad de la importacion). Grupos 8 y 9 a su cuenta del 13.
  const ap = e.apertura ?? null;
  if (ap && ap.tipo !== 'CON_CIERRE') {
    if (ap.grupos89.sinDestino.length) {
      p({
        clave: 'apertura:grupos-89',
        nivel: 'ERROR',
        texto: `${varios(ap.grupos89.sinDestino.length, 'cuenta de los grupos 8 o 9 tiene', 'cuentas de los grupos 8 y 9 tienen')} saldo y no se sabe a qué cuenta del patrimonio neto va. Pide a la gestoría el sumas y saldos con los grupos 8 y 9 ya regularizados.`,
        detalle: lista(ap.grupos89.sinDestino.map((c) => `${c.codigo} ${c.nombre} (${eur(c.saldo)})`)),
      });
    }
    if (ap.grupos89.traspasos.length) {
      p({
        clave: 'apertura:grupos-89-traspaso',
        nivel: 'INFO',
        texto: `${varios(ap.grupos89.traspasos.length, 'cuenta de los grupos 8 o 9 tiene', 'cuentas de los grupos 8 y 9 tienen')} saldo: en la apertura pasa a su cuenta del patrimonio neto (subvenciones, ajustes por cambios de valor...), como al cerrar el año.`,
        detalle: lista(ap.grupos89.traspasos.map((c) => `${c.codigo} ${c.nombre} (${eur(c.saldo)}) → ${c.a}`)),
      });
    }
    if (!ap.totalesApertura.cuadra && !puntos.some((x) => x.clave === 'sys:descuadre')) {
      p({
        clave: 'apertura:descuadre',
        nivel: 'ERROR',
        texto: `La apertura del 1-1-${anio + 1} no cuadra: debe ${eur(ap.totalesApertura.debe)} y haber ${eur(ap.totalesApertura.haber)} (diferencia ${eur(Math.round((ap.totalesApertura.debe - ap.totalesApertura.haber) * 100) / 100)}). Falta alguna cuenta en los ficheros: pide a la gestoría el sumas y saldos completo a 31-12-${anio}.`,
      });
    }
  }

  // 4. Plan: codigos fuera del PGC con saldo y longitudes.
  if (e.sinMadreConSaldo.length) {
    p({
      clave: 'plan:sin-madre',
      nivel: 'ERROR',
      texto: `${varios(e.sinMadreConSaldo.length, 'cuenta con saldo o movimientos no encaja', 'cuentas con saldo o movimientos no encajan')} en el Plan General Contable (su cuenta de 3 dígitos no existe). Pide a la gestoría que las reclasifique.`,
      detalle: lista(e.sinMadreConSaldo),
    });
  }
  if (e.longitudesIncoherentes.length) {
    p({
      clave: 'plan:longitud',
      nivel: 'ERROR',
      texto: e.ficherosConOtraLongitud?.length
        ? `${e.ficherosConOtraLongitud
            .map((f) => `En ${f.fichero} hay ${varios(f.subcuentas, 'subcuenta de cliente o proveedor', 'subcuentas de clientes o proveedores')} de ${f.longitud} dígitos`)
            .join('. ')}, y el plan usa ${e.longitud.delPlan}. Pide a la gestoría todos los listados al mismo nivel que el plan.`
        : `${varios(e.longitudesIncoherentes.length, 'subcuenta de cliente o proveedor tiene', 'subcuentas de clientes o proveedores tienen')} otra longitud que las del plan (${e.longitud.delPlan} dígitos). Pide a la gestoría todos los listados al mismo nivel.`,
      detalle: lista(e.longitudesIncoherentes),
    });
  }
  if (e.longitud.motivo) p({ clave: 'plan:longitud-convive', nivel: 'FALTA', texto: e.longitud.motivo });

  // 5. Clientes y proveedores con saldo sin ficha con NIF.
  if (e.tercerosConSaldoSinFicha.length) {
    p({
      clave: 'terceros:sin-ficha',
      nivel: 'FALTA',
      texto: `${varios(e.tercerosConSaldoSinFicha.length, 'cliente o proveedor con saldo no tiene', 'clientes o proveedores con saldo no tienen')} ficha con NIF: sin NIF no se puede crear. Escríbelo o enlázalos a su ficha después.`,
      detalle: lista(e.tercerosConSaldoSinFicha.map((t) => `${t.codigo} ${t.nombre}${t.motivo ? `: ${t.motivo}` : ''}`)),
    });
  }

  // 6. Diario (D2: si no cuadra, se deja fuera y la carga sigue).
  if (e.diario) {
    const d = e.diario;
    const necesario = !e.sumasSaldos && e.saldosDesdeDiario;
    const nivelDiario: NivelPunto = necesario ? 'ERROR' : 'FALTA';
    const sinDiario = necesario ? '' : ' El diario no se importará hasta que subas uno que cuadre; el resto de la carga sigue.';
    if (d.resumen.asientos === 0) {
      p({ clave: 'diario:vacio', nivel: nivelDiario, texto: `El diario no trae asientos de ${anio}.${sinDiario}`, excluye: 'DIARIO' });
    }
    if (d.descuadrados.length) {
      p({
        clave: 'diario:descuadre',
        nivel: nivelDiario,
        texto: `${varios(d.descuadrados.length, 'asiento del diario no cuadra', 'asientos del diario no cuadran')} (Debe distinto de Haber).${sinDiario}`,
        detalle: lista(d.descuadrados.map((x) => `${x.clave} del ${fechaEs(x.fecha)}: diferencia ${eur(x.diferencia)}`)),
        excluye: 'DIARIO',
      });
    }
    if (d.comparacion && !d.comparacion.cuadra) {
      p({
        clave: 'diario:sumas-saldos',
        nivel: 'FALTA',
        texto: `El diario no coincide con el sumas y saldos en ${varios(d.comparacion.diferencias.length, 'subcuenta', 'subcuentas')}. Pide a la gestoría los dos listados a la misma fecha.${sinDiario}`,
        detalle: lista(d.comparacion.diferencias.map((x) => `${x.codigo}: diario ${eur(x.diario)}, sumas y saldos ${eur(x.sumasSaldos)}`)),
        excluye: 'DIARIO',
      });
    }
    if (d.acabaAntesDelCorte) {
      p({ clave: 'diario:corte', nivel: 'FALTA', texto: `El diario acaba el ${fechaEs(d.resumen.hasta)}, antes que el sumas y saldos: faltan los últimos asientos.` });
    }
    if (d.deOtrosAnios) p({ clave: 'diario:otros-anios', nivel: 'AVISO', texto: `${varios(d.deOtrosAnios, 'apunte del diario no es', 'apuntes del diario no son')} de ${anio}: no se importan.` });
    if (d.lineasGrupos89) p({ clave: 'diario:grupos-89', nivel: 'AVISO', texto: `${varios(d.lineasGrupos89, 'apunte del diario es', 'apuntes del diario son')} de los grupos 8 y 9: se guardan en el histórico, pero esas cuentas no se crean en el plan.` });
  }

  // 7. Cartera (D3: lo que no cuadra va a una partida «Saldo sin detalle»).
  if (e.cartera) {
    if (e.cartera.sinTercero.length) {
      p({
        clave: 'cartera:sin-tercero',
        nivel: 'ERROR',
        texto: `${varios(e.cartera.sinTercero.length, 'partida de la cartera no tiene', 'partidas de la cartera no tienen')} un cliente o proveedor que se encuentre en el plan (por subcuenta, NIF o nombre).`,
        detalle: lista(e.cartera.sinTercero.map((x) => `Fila ${x.fila}: ${x.documento}${x.nombre ? ` · ${x.nombre}` : ''}${x.nif ? ` · ${x.nif}` : ''}${x.subcuenta ? ` · ${x.subcuenta}` : ''}`)),
      });
    }
    const diferencias = e.cartera.cuadre.filter((c) => aCentimos(c.diferencia) !== 0);
    if (diferencias.length) {
      p({
        clave: 'cartera:cuadre',
        nivel: 'FALTA',
        texto: `En ${varios(diferencias.length, 'cliente o proveedor', 'clientes o proveedores')} las facturas pendientes no suman su saldo: la diferencia queda como «Saldo sin detalle a 31-12-${anio}», para poder cobrarla o pagarla, hasta que llegue el detalle.`,
        detalle: lista(diferencias.map((c: CuadreSubcuenta) => `${c.subcuenta}: saldo ${eur(c.saldoApertura)}, facturas ${eur(c.sumaPartidas)}, diferencia ${eur(c.diferencia)}`)),
      });
    }
  }

  // 8. Inmovilizado (D2).
  if (e.inmovilizado?.diferencias.length) {
    p({
      clave: 'inmovilizado:cuadre',
      nivel: 'FALTA',
      texto: 'Las fichas de inmovilizado no suman el saldo de sus cuentas. Las fichas no se importarán hasta que subas un listado que cuadre; el resto de la carga sigue.',
      detalle: lista(e.inmovilizado.diferencias.map((d) => `${d.codigo}: fichas ${eur(d.fichas)}, saldo ${eur(d.saldo)}`)),
      excluye: 'INMOVILIZADO',
    });
  }

  // 9. Asientos de 2026 hechos en la app que se retiran.
  const totalRetirados = Object.values(e.retirados).reduce((a, b) => a + b, 0);
  if (totalRetirados) {
    p({
      clave: 'app:retirados',
      nivel: 'INFO',
      texto: `${varios(totalRetirados, 'asiento de 2026 hecho en la app se retira', 'asientos de 2026 hechos en la app se retiran')}: 2026 pasa a ser lo que diga la gestoría. Las facturas no se tocan.`,
      detalle: Object.entries(e.retirados).map(([o, n]) => `${o}: ${n}`),
    });
  }

  const excluidos = [...new Set(puntos.filter((x) => x.excluye && x.nivel !== 'ERROR').map((x) => x.excluye!))];
  return { ...nivelDe(puntos, anio), puntos, excluidos };
}

/** Nivel y mensaje de A4 a partir de los puntos. */
export function nivelDe(puntos: PuntoComprobacion[], anio: number): { nivel: NivelCarga; mensaje: string } {
  const errores = puntos.filter((x) => x.nivel === 'ERROR');
  const faltan = puntos.filter((x) => x.nivel === 'FALTA');
  const nivel: NivelCarga = errores.length ? 'ERRORES' : faltan.length ? 'FALTAN_DATOS' : 'CORRECTO';
  const resumen = (xs: PuntoComprobacion[]) => xs.slice(0, 3).map((x) => x.texto).join(' ') + (xs.length > 3 ? ` (y ${xs.length - 3} más)` : '');
  const mensaje =
    nivel === 'CORRECTO'
      ? `La contabilidad de ${anio} está completa y cuadra. Ya puedes seguir con ${anio + 1}.`
      : nivel === 'FALTAN_DATOS'
        ? `Puedes seguir, pero faltan datos: ${resumen(faltan)}`
        : `Todavía no se puede traer la contabilidad: ${resumen(errores)}`;
  return { nivel, mensaje };
}

// ---------------------------------------------------------------------------
// Comprobaciones «vivas»: las que se arreglan fuera de los ficheros (bancos,
// datos fiscales, datos de la empresa, series...) y se recalculan cada vez.
// No cuentan para la huella de la carga.
// ---------------------------------------------------------------------------

/** Claves de los puntos que se recalculan cada vez (no salen de los ficheros). */
export const esPuntoVivo = (clave: string) => /^(bancos|empresa|series|ejercicio):|^iva:(303|compensar)/.test(clave);

export interface BancoComprobar {
  subcuenta: string;
  nombre: string;
  /** Saldo de la 572 en la apertura (deudor > 0). */
  saldoApertura: number;
  saldoExtracto: number | null;
  /** Cuenta de Tesoreria con la que se enlaza (IBAN), o null si no hay. */
  cuenta: string | null;
  aceptada: boolean;
}

export interface EntradaVivas {
  ejercicioOrigen: number;
  bancos: BancoComprobar[] | null;
  /** Saldos de la apertura que tienen que ver con el 303 del 4T (positivos) y lo escrito a mano. */
  iva: { saldo4750: number; saldo4700: number; resultado303: number | null; cuotasACompensar: number | null } | null;
  /** Datos de la empresa que faltan (nombres para la persona). */
  empresaFaltan: string[];
  /** Tipos sin serie activa y predeterminada; series predeterminadas ya usadas en el año anterior. */
  series: { faltan: string[]; usadasAntes: string[] };
  /** null: se crea al importar. */
  ejercicioCreado: boolean | null;
  /** Solo con la carga ya importada: subcuentas de clientes y proveedores con saldo sin ficha con NIF. */
  tercerosSinFicha?: Array<{ codigo: string; nombre: string }>;
}

/** Puntos de las comprobaciones vivas (funcion pura). */
export function comprobarVivas(e: EntradaVivas): PuntoComprobacion[] {
  const puntos: PuntoComprobacion[] = [];
  const anio = e.ejercicioOrigen;
  const fin = `31-12-${anio}`;

  if (e.bancos) {
    const sinExtracto = e.bancos.filter((b) => b.saldoExtracto === null);
    if (sinExtracto.length) {
      puntos.push({
        clave: 'bancos:extracto',
        nivel: 'FALTA',
        texto: `Escribe el saldo del extracto a ${fin} de ${varios(sinExtracto.length, 'banco', 'bancos')} (lo da el banco, no la gestoría).`,
        detalle: lista(sinExtracto.map((b) => `${b.subcuenta} ${b.nombre}: en la contabilidad ${eur(b.saldoApertura)}`)),
      });
    }
    const sinCuenta = e.bancos.filter((b) => !b.cuenta);
    if (sinCuenta.length) {
      puntos.push({
        clave: 'bancos:cuenta',
        nivel: 'FALTA',
        texto: `${varios(sinCuenta.length, 'cuenta de bancos no está enlazada', 'cuentas de bancos no están enlazadas')} con su cuenta de Tesorería: elige la cuenta o escribe su IBAN para darla de alta.`,
        detalle: lista(sinCuenta.map((b) => `${b.subcuenta} ${b.nombre}`)),
      });
    }
    const diferencias = e.bancos.filter((b) => b.saldoExtracto !== null && aCentimos(b.saldoExtracto) !== aCentimos(b.saldoApertura));
    const sinAceptar = diferencias.filter((b) => !b.aceptada);
    if (sinAceptar.length) {
      puntos.push({
        clave: 'bancos:diferencia',
        nivel: 'FALTA',
        texto: `El saldo del extracto no coincide con la contabilidad en ${varios(sinAceptar.length, 'banco', 'bancos')}. Si son cobros o pagos en tránsito a ${fin} (un cheque, un recibo que el banco cargó en enero...), acéptalo; si no, revísalo con la gestoría.`,
        detalle: lista(sinAceptar.map((b) => `${b.subcuenta} ${b.nombre}: contabilidad ${eur(b.saldoApertura)}, extracto ${eur(b.saldoExtracto!)}, diferencia ${eur(b.saldoApertura - b.saldoExtracto!)}`)),
      });
    }
    const aceptadas = diferencias.filter((b) => b.aceptada);
    if (aceptadas.length) {
      puntos.push({
        clave: 'bancos:transito',
        nivel: 'INFO',
        texto: `${varios(aceptadas.length, 'banco tiene', 'bancos tienen')} partidas en tránsito a ${fin} aceptadas.`,
        detalle: lista(aceptadas.map((b) => `${b.subcuenta} ${b.nombre}: diferencia ${eur(b.saldoApertura - b.saldoExtracto!)}`)),
      });
    }
  }

  if (e.iva) {
    const { saldo4750, saldo4700, resultado303, cuotasACompensar } = e.iva;
    if (resultado303 === null) {
      puntos.push({
        clave: 'iva:303-4t',
        nivel: 'FALTA',
        texto: `Escribe el resultado del 303 del 4T de ${anio} (a ingresar, en positivo; a devolver o a compensar, en negativo), para comprobarlo con las cuentas de IVA.`,
      });
    } else {
      const esperado = aCentimos(saldo4750) ? saldo4750 : aCentimos(saldo4700) ? -saldo4700 : 0;
      if (aCentimos(resultado303) !== aCentimos(esperado)) {
        const cuentas = aCentimos(saldo4750)
          ? `la 4750 (IVA a ingresar) tiene ${eur(saldo4750)}`
          : aCentimos(saldo4700)
            ? `la 4700 (IVA a devolver o a compensar) tiene ${eur(saldo4700)}`
            : 'ni la 4750 ni la 4700 tienen saldo';
        puntos.push({
          clave: 'iva:303-4t',
          nivel: 'FALTA',
          texto: `El 303 del 4T que has escrito (${eur(resultado303)}) no cuadra con la contabilidad: ${cuentas}. Revísalo con la gestoría.`,
        });
      }
      if (resultado303 < 0 && cuotasACompensar === null) {
        puntos.push({
          clave: 'iva:compensar',
          nivel: 'FALTA',
          texto: `El 303 del 4T salió negativo: escribe las cuotas de IVA que quedan por compensar en ${anio + 1} (0 si pediste la devolución). Saldrán solas en el 303 del 1T.`,
        });
      }
    }
  }

  if (e.empresaFaltan.length) {
    puntos.push({
      clave: 'empresa:datos',
      nivel: 'FALTA',
      texto: `Faltan datos de la empresa que piden los modelos de Hacienda: ${e.empresaFaltan.join(', ')}. Complétalos en Más > Datos de la empresa.`,
    });
  }
  if (e.series.faltan.length) {
    puntos.push({
      clave: 'series:2027',
      nivel: 'FALTA',
      texto: `No hay una serie activa y predeterminada de ${e.series.faltan.join(' ni de ')} para ${anio + 1}. Créalas con «Crear series ${anio + 1}».`,
    });
  } else if (e.series.usadasAntes.length) {
    puntos.push({
      clave: 'series:anteriores',
      nivel: 'INFO',
      texto: `La serie ${e.series.usadasAntes.join(' y la ')} ya se usó en ${anio}. Si quieres empezar ${anio + 1} con el número 1, crea las series de ${anio + 1}.`,
    });
  }
  if (e.ejercicioCreado === false) {
    puntos.push({ clave: 'ejercicio:2027', nivel: 'FALTA', texto: `Falta el ejercicio ${anio + 1}: créalo en Configuración > Ejercicios y periodos.` });
  }
  if (e.tercerosSinFicha?.length) {
    puntos.push({
      clave: 'terceros:sin-ficha',
      nivel: 'FALTA',
      texto: `${varios(e.tercerosSinFicha.length, 'cliente o proveedor con saldo no tiene', 'clientes o proveedores con saldo no tienen')} ficha con NIF. Enlázalos con su ficha en Contabilidad > Puesta en marcha > Plan anterior.`,
      detalle: lista(e.tercerosSinFicha.map((t) => `${t.codigo} ${t.nombre}`)),
    });
  }
  return puntos;
}

export interface AvisoAceptado {
  clave: string;
  motivo: string;
  userId: string;
  en: string;
}

/**
 * Junta los puntos de los ficheros con los vivos (que sustituyen a los de la
 * misma clase) y los avisos aceptados (que pasan a informacion), y calcula el
 * nivel.
 */
export function juntarComprobaciones(
  base: Pick<ResultadoComprobaciones, 'puntos' | 'excluidos'>,
  vivos: PuntoComprobacion[],
  anio: number,
  aceptados: AvisoAceptado[] = [],
  sustituir: (clave: string) => boolean = esPuntoVivo,
): ResultadoComprobaciones & { aceptados: AvisoAceptado[] } {
  const porClave = new Map(aceptados.map((a) => [a.clave, a]));
  const puntos = [...base.puntos.filter((p) => !sustituir(p.clave)), ...vivos].map((p) => {
    const a = p.nivel === 'FALTA' ? porClave.get(p.clave) : undefined;
    return a ? { ...p, nivel: 'INFO' as const, texto: `${p.texto} (Aceptado: ${a.motivo})` } : p;
  });
  return { ...nivelDe(puntos, anio), puntos, excluidos: base.excluidos, aceptados: aceptados.filter((a) => puntos.some((p) => p.clave === a.clave)) };
}
