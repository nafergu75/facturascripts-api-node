import { generarFicheroModelo390 } from '../../services/impuestosExport.service';
import { DatosModelo390 } from '../../domain/impuestos.model';
import { modelo390Schema, Modelo390Input } from './modelo390.schema';

/** Genera el fichero del Modelo 390 validando con Zod y delegando en el generador verificado. */
export function generarFichero390Validado(input: unknown): string {
  const v: Modelo390Input = modelo390Schema.parse(input);
  return generarFicheroModelo390(v.nif, v.ejercicio, v.datos as DatosModelo390);
}
