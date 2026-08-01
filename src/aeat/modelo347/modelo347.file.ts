import { Declarante347Dom, Declarado347Dom } from './modelo347.types';
import { generarLineaDeclarante347, generarLineaDeclarado347 } from './modelo347.encoder';

/** Fichero 347 completo: 1 registro Tipo 1 (declarante) + N Tipo 2 (declarados). */
export function generarFichero347(declarante: Declarante347Dom, declarados: Declarado347Dom[]): string {
  const lineas = [generarLineaDeclarante347(declarante), ...declarados.map((d) => generarLineaDeclarado347(d))];
  return lineas.join('\r\n') + '\r\n';
}
