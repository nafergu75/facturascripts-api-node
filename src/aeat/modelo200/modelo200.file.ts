import { generarFicheroModelo200 } from '../../services/impuestosExport.service';
import { modelo200Schema, Modelo200Input } from './modelo200.schema';

/** Genera el fichero del Modelo 200 validando con Zod y delegando en el generador verificado. */
export function generarFichero200Validado(input: unknown): string {
  const v: Modelo200Input = modelo200Schema.parse(input);
  return generarFicheroModelo200(v.nif, v.ejercicio, v.opts);
}
