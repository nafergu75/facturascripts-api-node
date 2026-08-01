import { generarFicheroModelo115 } from '../../services/impuestosExport.service';
import { DatosModelo115 } from '../../domain/impuestos.model';
import { modelo115Schema, Modelo115Input } from './modelo115.schema';

/** Genera el fichero del Modelo 115 validando con Zod y delegando en el generador verificado. */
export function generarFichero115Validado(input: unknown): string {
  const v: Modelo115Input = modelo115Schema.parse(input);
  return generarFicheroModelo115(v.nif, v.datos.periodo, v.datos as DatosModelo115, { razonSocial: v.razonSocial });
}
