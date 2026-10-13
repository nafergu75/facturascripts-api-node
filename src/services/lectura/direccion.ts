/**
 * Direccion leida de una factura (del cliente o del proveedor), lista para la
 * ficha que se da de alta desde el lector: calle, codigo postal, municipio,
 * provincia y pais, cada uno en su casilla.
 *
 * El pais se da como codigo ISO de dos letras (ES, FR, PT...) solo si se sabe
 * con seguridad (Azure lo da en ISO-3, «ESP»; Claude, como venga escrito). Si
 * no, null: mejor una casilla vacia que un pais equivocado. Ni el correo ni el
 * telefono los da el lector: no se inventan.
 */
import { paisIsoLeido } from './pais-leido';
import type { Campo, DireccionLeida } from './tipos';
import { estadoPorConfianza } from './validaciones';

/** La forma que leen las pantallas (direccionCliente en ventas, direccionProveedor en gastos). */
export interface DireccionFicha {
  calle: string | null;
  cp: string | null;
  municipio: string | null;
  provincia: string | null;
  /** ISO-2 en mayusculas, o null si no se sabe con seguridad. */
  pais: string | null;
  /** true si la direccion se ha leido con poca seguridad: hay que revisarla. */
  revisar: boolean;
}

// paisIsoLeido vive en pais-leido.ts (sin dependencias del lector, para que lo usen tambien las validaciones).
export { paisIsoLeido } from './pais-leido';

const limpio = (v: string | null | undefined): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
};

/** Direccion leida (Azure o Claude) -> la de la ficha. null si no se ha leido nada que sirva. */
export function direccionParaFicha(campo: Campo<DireccionLeida> | null | undefined): DireccionFicha | null {
  const d = campo?.valor;
  if (!campo || !d) return null;
  const ficha: DireccionFicha = {
    calle: limpio(d.calle),
    cp: limpio(d.cp),
    municipio: limpio(d.municipio),
    provincia: limpio(d.provincia),
    pais: paisIsoLeido(d.pais),
    revisar: false,
  };
  if (!ficha.calle && !ficha.cp && !ficha.municipio && !ficha.provincia && !ficha.pais) return null;
  // Mismo criterio que el resto de datos leidos (poca confianza de Azure, motivo...).
  ficha.revisar = estadoPorConfianza(campo).nivel !== 'ok';
  return ficha;
}
