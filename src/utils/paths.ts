import os from 'os';
import path from 'path';

/** true si corremos como funcion serverless de Vercel (disco de solo lectura salvo /tmp). */
export const enServerless = (): boolean => Boolean(process.env.VERCEL);

/**
 * Carpeta donde se puede escribir: el directorio temporal en Vercel (el resto
 * del disco es de solo lectura) y la del proyecto en local. En serverless lo
 * escrito no sobrevive entre invocaciones: vale para ficheros de paso, no para
 * guardar nada de forma permanente.
 */
export function dirEscribible(...partes: string[]): string {
  return path.join(enServerless() ? os.tmpdir() : process.cwd(), ...partes);
}
