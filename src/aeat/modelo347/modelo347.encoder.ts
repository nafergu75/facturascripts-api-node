import { construirLineaDesdeCampos } from '../common/aeat-encoder';
import { CAMPOS_347_TIPO1, CAMPOS_347_TIPO2, LONGITUD_REGISTRO_347 } from './modelo347.diseno';
import { Declarante347Dom, Declarado347Dom } from './modelo347.types';
import { validarDeclarante347, validarDeclarado347 } from './modelo347.schema';

/** Importe 347: signo (' '/'N') + 15 digitos en centimos. */
function importe347(v: number): string {
  const c = Math.round(Math.abs(v) * 100);
  return (v < 0 ? 'N' : ' ') + String(c).padStart(15, '0').slice(-15);
}
const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

function linea(campos: { nombre: string; posicionInicio: number; longitud: number; tipo: 'A' | 'N' | 'AN' }[], valores: Record<string, string | number>): string {
  const mapped = campos.map((diseno) => ({ diseno, valor: valores[diseno.nombre] }));
  return construirLineaDesdeCampos(mapped).padEnd(LONGITUD_REGISTRO_347, ' ').slice(0, LONGITUD_REGISTRO_347);
}

/** Linea Tipo 1 (declarante): valida con Zod y codifica segun el diseno. */
export function generarLineaDeclarante347(input: Declarante347Dom): string {
  const d = validarDeclarante347(input);
  return linea(CAMPOS_347_TIPO1, {
    tipoRegistro: '1',
    modelo: '347',
    ejercicio: d.ejercicio,
    nif: d.nif,
    razonSocial: sinAcentos(d.razonSocial),
    tipoSoporte: 'T',
    telefono: 0,
    numIdentificativo: '347' + '0'.repeat(10),
    numPersonas: d.numPersonas,
    importeTotal: importe347(d.importeTotal),
    numInmuebles: 0,
    importeArrendamientos: importe347(0),
  });
}

/** Linea Tipo 2 (declarado): valida con Zod y codifica segun el diseno. */
export function generarLineaDeclarado347(input: Declarado347Dom): string {
  const d = validarDeclarado347(input);
  return linea(CAMPOS_347_TIPO2, {
    tipoRegistro: '2',
    modelo: '347',
    ejercicio: d.ejercicio,
    nifDeclarante: d.nifDeclarante,
    nifDeclarado: d.nifDeclarado,
    razonSocial: sinAcentos(d.razonSocial),
    tipoHoja: 'D',
    provincia: 0,
    clave: d.clave,
    importeAnual: importe347(d.importeAnual),
    importeMetalico: 0,
  });
}
