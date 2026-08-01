import { generarFicheroModelo349 } from '../../services/impuestosExport.service';
import { DatosModelo349 } from '../../domain/impuestos.model';
import { modelo349Schema, Modelo349Input } from './modelo349.schema';

/** Genera el fichero del Modelo 349 validando con Zod y delegando en el generador verificado. */
export function generarFichero349Validado(input: unknown): string {
  const v: Modelo349Input = modelo349Schema.parse(input);
  return generarFicheroModelo349(v.nif, v.datos.periodo, v.datos as DatosModelo349, v.razonSocial);
}
