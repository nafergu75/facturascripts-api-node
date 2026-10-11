import {
  DatosNuevaFamiliaProducto,
  DatosNuevoTercero,
  SugerenciaSubcuenta,
} from '../domain/sugerencias-contables.model';
import { listarSubcuentasEmpresa } from './planContable.service';
import { prisma } from '../config/database';
import { codigoSubcuenta, PREFIJOS_CLIENTE, PREFIJOS_PROVEEDOR, siguienteNumeroTercero } from './terceros/numeracion';
import { codigosDeTerceros, longitudSubcuentasEmpresa } from './terceros/subcuentas';

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
 * Subcuenta de un cliente (430) o proveedor (400) por su NIF: la de su ficha si
 * ya existe, o la que recibira al darlo de alta (la siguiente libre con la
 * longitud de la empresa; services/terceros). Solo lee: no asigna nada. Antes
 * proponia siempre un codigo de 10 digitos del plan en memoria.
 */
export async function sugerirSubcuentaParaTercero(companyId: string, datos: DatosNuevoTercero): Promise<SugerenciaSubcuenta> {
  const esCliente = datos.tipo === 'cliente';
  const cuentaBaseCodigo = esCliente ? '430' : '400';
  const nif = String(datos.nif ?? '').replace(/[\s.-]/g, '').toUpperCase();
  const ficha = esCliente
    ? await prisma.customer.findFirst({ where: { companyId, nifCif: nif }, select: { nombreFiscal: true, subcuenta430: true } })
    : await prisma.supplier.findFirst({ where: { companyId, nifCif: nif }, select: { nombreFiscal: true, subcuenta400: true } });
  const suya = ficha ? ('subcuenta430' in ficha ? ficha.subcuenta430 : ficha.subcuenta400) : null;
  if (ficha && suya) {
    return {
      codigoPropuesto: suya,
      nombrePropuesto: ficha.nombreFiscal,
      cuentaBaseCodigo,
      motivo: `Es la subcuenta de la ficha de ${ficha.nombreFiscal} (${nif}).`,
    };
  }
  const prefijos = esCliente ? PREFIJOS_CLIENTE : PREFIJOS_PROVEEDOR;
  const longitud = await longitudSubcuentasEmpresa(companyId);
  const n = siguienteNumeroTercero(await codigosDeTerceros(prisma, companyId, prefijos), prefijos, longitud);
  return {
    codigoPropuesto: codigoSubcuenta(cuentaBaseCodigo, n, longitud),
    nombrePropuesto: datos.nombre,
    cuentaBaseCodigo,
    motivo: `Nuevo ${datos.tipo} "${datos.nombre}" (${datos.nif}): la subcuenta que recibirá al darlo de alta (siguiente libre de la ${cuentaBaseCodigo}).`,
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
