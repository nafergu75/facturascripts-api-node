import { generarFicheroModelo111 } from '../../services/impuestosExport.service';
import { DatosModelo111 } from '../../domain/impuestos.model';
import { modelo111Schema, Modelo111Input } from './modelo111.schema';

/** Genera el fichero del Modelo 111 validando con Zod y delegando en el generador verificado. */
export function generarFichero111Validado(input: unknown): string {
  const v: Modelo111Input = modelo111Schema.parse(input);
  return generarFicheroModelo111(v.nif, v.datos.periodo, v.datos as DatosModelo111, { denominacion: v.denominacion });
}
