import { CampoDiseno } from '../common/aeat-encoder';
import { DR111, registroDr } from '../../services/aeatRetenciones/diseno';

/**
 * Diseno del Modelo 111 (retenciones IRPF) — pagina M11101, longitud 1000, con
 * la envoltura <AUX> (328) y el cierre (18). Fuente: dr111e16v18.xls (v1.8,
 * mayo de 2021), transcrito en src/domain/aeat/dr111-v2.json, que es lo que usa
 * el generador. Aqui se expone en formato CampoDiseno (los 48 campos).
 */
export const LONGITUD_REGISTRO_111 = 1000;

export const CAMPOS_111_M11101: CampoDiseno[] = registroDr(DR111, 'M11101').campos.map((c) => ({
  nombre: c.clave ?? (c.casilla ? `casilla${c.casilla}` : `campo${c.n}`),
  posicionInicio: c.pos,
  longitud: c.lon,
  tipo: c.tipo === 'Num' || c.tipo === 'N' ? 'N' : c.tipo === 'A' ? 'A' : 'AN',
  ...(c.decimales ? { decimales: c.decimales } : {}),
}));
