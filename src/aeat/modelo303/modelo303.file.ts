import { generarFicheroModelo303 } from '../../services/impuestosExport.service';
import { DatosModelo303 } from '../../domain/impuestos.model';
import { modelo303Schema, Modelo303Input } from './modelo303.schema';

/**
 * Genera el fichero BOE del Modelo 303 VALIDANDO la entrada con Zod antes de
 * delegar en el generador verificado (impuestosExport.service). El framework
 * (schema + diseno) aporta la capa de validacion del Punto 1; el layout exacto
 * de 1581 chars lo produce el generador ya probado en vivo.
 */
export function generarFichero303Validado(input: unknown): string {
  const v: Modelo303Input = modelo303Schema.parse(input);
  return generarFicheroModelo303(v.nif, v.datos.periodo, v.datos as DatosModelo303, v.razonSocial);
}
