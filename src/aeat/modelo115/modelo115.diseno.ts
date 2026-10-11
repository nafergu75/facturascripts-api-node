import { CampoDiseno } from '../common/aeat-encoder';
import { DR115, registroDr } from '../../services/aeatRetenciones/diseno';

/**
 * Diseno del Modelo 115 (retenciones por arrendamiento de inmuebles urbanos) —
 * pagina DR11501, longitud 500, con la envoltura <AUX> (328) y el cierre (18).
 * Fuente: DR115e15v13.xls (v1.3, febrero de 2019), transcrito en
 * src/domain/aeat/dr115-v13.json, que es lo que usa el generador. Aqui se
 * expone en formato CampoDiseno (los 22 campos).
 */
export const LONGITUD_REGISTRO_115 = 500;

export const CAMPOS_115_DR11501: CampoDiseno[] = registroDr(DR115, 'DR11501').campos.map((c) => ({
  nombre: c.clave ?? (c.casilla ? `casilla${c.casilla}` : `campo${c.n}`),
  posicionInicio: c.pos,
  longitud: c.lon,
  tipo: c.tipo === 'Num' || c.tipo === 'N' ? 'N' : c.tipo === 'A' ? 'A' : 'AN',
  ...(c.decimales ? { decimales: c.decimales } : {}),
}));
