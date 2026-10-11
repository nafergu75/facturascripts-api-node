/**
 * Barril del framework AEAT (Punto 1): por cada modelo se expone un generador
 * VALIDADO (`generarFicheroXXXValidado`) que valida la entrada con Zod (schema
 * por modelo) y delega en el generador de layout verificado. Los `*.diseno.ts`
 * documentan las posiciones oficiales como CampoDiseno[].
 *
 * El 303 no esta aqui: su fichero completo (cabecera, paginas 1 y 3, DID y
 * cierre) sale del diseno oficial 2026 en services/modelo303.service
 * (ficheroBorrador303). El generador de solo la pagina 1 se retiro.
 */
export { generarFichero390Validado } from './modelo390/modelo390.file';
export { generarFichero349Validado } from './modelo349/modelo349.file';
export { generarFichero111Validado } from './modelo111/modelo111.file';
export { generarFichero115Validado } from './modelo115/modelo115.file';
export { generarFichero200Validado } from './modelo200/modelo200.file';

// Modelo 347 (referencia original del framework, encoder propio por CampoDiseno)
export { generarFichero347 } from './modelo347/modelo347.file';

export { modelo303Schema } from './modelo303/modelo303.schema';
export { modelo390Schema } from './modelo390/modelo390.schema';
export { modelo349Schema } from './modelo349/modelo349.schema';
export { modelo111Schema } from './modelo111/modelo111.schema';
export { modelo115Schema } from './modelo115/modelo115.schema';
export { modelo200Schema } from './modelo200/modelo200.schema';
