import {
  DatosNuevaFamiliaProducto,
  DatosNuevoTercero,
  SugerenciaSubcuenta,
} from '../domain/sugerencias-contables.model';
import { listarSubcuentasEmpresa } from './planContable.service';

/** Siguiente codigo correlativo de subcuenta para una cuenta base (430xxxxx, etc.). */
async function siguienteCodigo(companyId: string, cuentaBase: string, longitud = 10): Promise<string> {
  const subcuentas = await listarSubcuentasEmpresa(companyId);
  const mismas = subcuentas
    .filter((s) => s.codigo.startsWith(cuentaBase))
    .map((s) => Number(s.codigo.slice(cuentaBase.length)))
    .filter((n) => Number.isFinite(n));
  const siguiente = (mismas.length ? Math.max(...mismas) : 0) + 1;
  const sufijo = String(siguiente).padStart(longitud - cuentaBase.length, '0');
  return cuentaBase + sufijo;
}

/**
 * Sugiere la subcuenta para un nuevo cliente/proveedor: cuenta base 430 (cliente)
 * o 400 (proveedor) + correlativo siguiente. TODO: afinar por actividad/sector y
 * cruzar con ReglasContablesEmpresa.
 */
export async function sugerirSubcuentaParaTercero(companyId: string, datos: DatosNuevoTercero): Promise<SugerenciaSubcuenta> {
  const cuentaBaseCodigo = datos.tipo === 'cliente' ? '430' : '400';
  const codigoPropuesto = await siguienteCodigo(companyId, cuentaBaseCodigo);
  return {
    codigoPropuesto,
    nombrePropuesto: datos.nombre,
    cuentaBaseCodigo,
    motivo: `Nuevo ${datos.tipo} "${datos.nombre}" (${datos.nif}); siguiente correlativo de la cuenta ${cuentaBaseCodigo}.`,
  };
}

/**
 * Sugiere subcuenta de ingresos/compras para una nueva familia de producto.
 * Servicios -> 705 (prestacion de servicios); mercaderia/otro -> 700 (ventas).
 * TODO: permitir mapear compras (600/602) y cruzar con reglas existentes.
 */
export async function sugerirSubcuentaParaFamiliaProducto(
  companyId: string,
  datos: DatosNuevaFamiliaProducto,
): Promise<SugerenciaSubcuenta> {
  const cuentaBaseCodigo = datos.tipo === 'servicio' ? '705' : '700';
  const codigoPropuesto = await siguienteCodigo(companyId, cuentaBaseCodigo);
  return {
    codigoPropuesto,
    nombrePropuesto: `Ventas ${datos.nombre}`,
    cuentaBaseCodigo,
    motivo: `Familia "${datos.nombre}" (${datos.tipo}); subcuenta de ingresos sobre la cuenta ${cuentaBaseCodigo}.`,
  };
}
