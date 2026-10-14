/**
 * Cabeza de la cadena de VERI*FACTU (spec verifactu, 2.2 y 3.2): una fila de
 * VerifactuCadena por empresa y entorno, que se bloquea al generar cada registro.
 *
 * Orden de bloqueo en la emision, siempre el mismo (sin interbloqueos):
 * originales de la rectificativa -> serie (asignarNumero) -> cadena.
 *
 * La fila se crea ANTES, fuera de la transaccion (asegurarCadena, INSERT
 * IGNORE), y dentro solo se bloquea con SELECT ... FOR UPDATE, que en MariaDB y
 * en TiDB (modo pesimista) lee lo ultimo confirmado. Con READ COMMITTED (las
 * rectificativas) InnoDB no bloquea filas que no existen: por eso la fila tiene
 * que existir de antes. Las unicidades de VerifactuRegistro (registroAnteriorId
 * y companyId+entorno+numeroEnCadena) son la ultima defensa.
 *
 * avanzarCadena vive en este modulo (y se llama a traves de el) para que un
 * test pueda simular un fallo despues de crear el registro.
 *
 * Bloqueos en TiDB (produccion): comprobar una clave ajena al insertar bloquea
 * la fila padre en exclusiva. Por eso VerifactuRegistro no tiene clave ajena a
 * Company ni al registro anterior (ver schema.prisma): con la cadena ya
 * bloqueada, el registro nuevo no bloquea la empresa ni otros registros.
 * Para F3 y F4: dentro de una transaccion que ya tiene la cadena, nada de
 * inserts con clave ajena a Company (bitacora, lotes...); y el trabajador de
 * envio bloquea primero la cadena (donde esta el control de envio) y despues
 * los registros, en el mismo orden que una emision.
 */
import type { ClienteBD, TransaccionBD } from '../../config/database';
import { cadenaAlta, cadenaAnulacion, huella as calcularHuella } from './huella';
import { instanteDeHuso } from './formato';

export type EntornoVerifactu = 'PRUEBAS' | 'PRODUCCION';

/** Cabeza de la cadena tal como la lee el SELECT ... FOR UPDATE. */
export interface CabezaCadena {
  id: string;
  numRegistros: number;
  ultimoRegistroId: string | null;
  ultimaHuella: string | null;
  ultimoIdEmisor: string | null;
  ultimoNumSerie: string | null;
  ultimaFechaExpedicion: string | null;
  ultimaFechaHoraHuso: string | null;
}

/** Crea la fila de la cadena si no existe (fuera de la transaccion de emision). */
export async function asegurarCadena(db: ClienteBD | TransaccionBD, companyId: string, entorno: EntornoVerifactu): Promise<void> {
  await db.verifactuCadena.createMany({ data: [{ companyId, entorno }], skipDuplicates: true });
}

/** Bloquea la cabeza de la cadena hasta el final de la transaccion y la devuelve (null si no existe). */
export async function bloquearCadena(tx: TransaccionBD, companyId: string, entorno: EntornoVerifactu): Promise<CabezaCadena | null> {
  const filas = await tx.$queryRaw<CabezaCadena[]>`
    SELECT id, numRegistros, ultimoRegistroId, ultimaHuella, ultimoIdEmisor, ultimoNumSerie, ultimaFechaExpedicion, ultimaFechaHoraHuso
    FROM \`VerifactuCadena\` WHERE companyId = ${companyId} AND entorno = ${entorno} FOR UPDATE`;
  const f = filas[0];
  return f ? { ...f, numRegistros: Number(f.numRegistros) } : null;
}

/** Lo que pasa a ser la cabeza de la cadena tras un registro nuevo. */
export interface RegistroParaCadena {
  id: string;
  numeroEnCadena: number;
  idEmisor: string;
  numSerie: string;
  fechaExpedicion: string;
  fechaHoraHuso: string;
  huella: string;
}

/** Avanza la cabeza de la cadena al registro recien creado (con la fila ya bloqueada). */
export async function avanzarCadena(tx: TransaccionBD, cadenaId: string, r: RegistroParaCadena): Promise<void> {
  await tx.verifactuCadena.update({
    where: { id: cadenaId },
    data: {
      numRegistros: r.numeroEnCadena,
      ultimoRegistroId: r.id,
      ultimaHuella: r.huella,
      ultimoIdEmisor: r.idEmisor,
      ultimoNumSerie: r.numSerie,
      ultimaFechaExpedicion: r.fechaExpedicion,
      ultimaFechaHoraHuso: r.fechaHoraHuso,
    },
  });
}

/** Registro tal como lo lee la comprobacion de la cadena. */
export interface RegistroCadena {
  id: string;
  numeroEnCadena: number;
  registroAnteriorId: string | null;
  tipo: string;
  idEmisor: string;
  numSerie: string;
  fechaExpedicion: string;
  tipoFactura: string | null;
  cuotaTotal: string | null;
  importeTotal: string | null;
  fechaHoraHuso: string;
  huellaAnterior: string | null;
  huella: string;
}

/**
 * Comprueba una cadena (puro): registros 1..n sin huecos, cada uno enlazado al
 * anterior (registroAnteriorId y huellaAnterior), huellas recalculadas iguales
 * a las guardadas y fecha-hora que no va hacia atras. Devuelve los problemas
 * (vacio si esta bien). Sirve a los tests y a la verificacion periodica (6.7, fase F4).
 */
export function comprobarCadena(registros: RegistroCadena[]): string[] {
  const problemas: string[] = [];
  const orden = [...registros].sort((a, b) => a.numeroEnCadena - b.numeroEnCadena);
  orden.forEach((r, i) => {
    const anterior = i > 0 ? orden[i - 1] : null;
    if (r.numeroEnCadena !== i + 1) problemas.push(`Hueco en la cadena: se esperaba el ${i + 1} y está el ${r.numeroEnCadena}.`);
    if (!anterior) {
      if (r.registroAnteriorId || r.huellaAnterior) problemas.push(`El registro ${r.numeroEnCadena} es el primero y apunta a uno anterior.`);
    } else {
      if (r.registroAnteriorId !== anterior.id) problemas.push(`El registro ${r.numeroEnCadena} no apunta al ${anterior.numeroEnCadena}.`);
      if (r.huellaAnterior !== anterior.huella) problemas.push(`La huella anterior del registro ${r.numeroEnCadena} no es la del ${anterior.numeroEnCadena}.`);
      try {
        if (instanteDeHuso(r.fechaHoraHuso).getTime() < instanteDeHuso(anterior.fechaHoraHuso).getTime()) {
          problemas.push(`La fecha y hora del registro ${r.numeroEnCadena} es anterior a la del ${anterior.numeroEnCadena}.`);
        }
      } catch {
        problemas.push(`La fecha y hora del registro ${r.numeroEnCadena} no tiene el formato de la AEAT.`);
      }
    }
    const cadena =
      r.tipo === 'ANULACION'
        ? cadenaAnulacion({ idEmisor: r.idEmisor, numSerie: r.numSerie, fecha: r.fechaExpedicion, huellaAnterior: r.huellaAnterior ?? '', fechaHoraHuso: r.fechaHoraHuso })
        : cadenaAlta({
            idEmisor: r.idEmisor,
            numSerie: r.numSerie,
            fecha: r.fechaExpedicion,
            tipoFactura: r.tipoFactura ?? '',
            cuotaTotal: r.cuotaTotal ?? '',
            importeTotal: r.importeTotal ?? '',
            huellaAnterior: r.huellaAnterior ?? '',
            fechaHoraHuso: r.fechaHoraHuso,
          });
    if (calcularHuella(cadena) !== r.huella) problemas.push(`La huella del registro ${r.numeroEnCadena} no coincide con sus datos.`);
  });
  return problemas;
}
