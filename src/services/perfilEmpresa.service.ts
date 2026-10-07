import { prisma, type ClienteBD, type TransaccionBD } from '../config/database';
import {
  esPaisEspana,
  formatoPorPais,
  idiomaPorPais,
  regimenIvaPorPais,
  type FormatoDocumento,
  type Idioma,
} from '../domain/perfil-empresa.model';
import { MONEDA_CUENTA_POR_DEFECTO, MONEDAS_FACTURA_ACTIVAS, normalizarMoneda } from '../domain/divisas';

/**
 * Perfil de la empresa para facturar: pais, si es espanola, moneda de cuenta,
 * regimen de IVA, idioma y formato de sus facturas, y monedas en las que puede
 * facturar. UNICA fuente: todo lo que dependa de esto lo lee de aqui.
 *
 * Sin configuracion legal (empresas antiguas): espanola y en euros.
 */
export interface PerfilEmpresa {
  pais: string;
  espanola: boolean;
  monedaCuenta: string;
  regimenIva: 'ES' | 'NINGUNO';
  idioma: Idioma;
  formato: FormatoDocumento;
  /** Monedas en las que puede emitir: las activas si es espanola; si no, solo la suya. */
  monedasFactura: readonly string[];
}

type Db = ClienteBD | TransaccionBD;

/** Perfil a partir de la fila de LegalConfig (o de su ausencia). */
export function perfilDesdeConfig(cfg: { pais?: string | null; monedaCuenta?: string | null } | null): PerfilEmpresa {
  const pais = String(cfg?.pais ?? 'ES').trim().toUpperCase() || 'ES';
  const espanola = esPaisEspana(pais);
  const monedaCuenta = normalizarMoneda(cfg?.monedaCuenta) || MONEDA_CUENTA_POR_DEFECTO;
  return {
    pais,
    espanola,
    monedaCuenta,
    regimenIva: regimenIvaPorPais(pais),
    idioma: idiomaPorPais(pais),
    formato: formatoPorPais(pais),
    monedasFactura: espanola ? MONEDAS_FACTURA_ACTIVAS : [monedaCuenta],
  };
}

export async function perfilEmpresa(companyId: string, db: Db = prisma): Promise<PerfilEmpresa> {
  const cfg = await db.legalConfig.findUnique({ where: { companyId }, select: { pais: true, monedaCuenta: true } });
  return perfilDesdeConfig(cfg);
}

/** true si la empresa esta establecida en Espana (o no tiene configuracion legal). */
export async function esEmpresaEspanola(companyId: string, db?: Db): Promise<boolean> {
  return (await perfilEmpresa(companyId, db)).espanola;
}

/** Moneda de la contabilidad de la empresa (EUR si no hay configuracion). */
export async function monedaDeCuenta(companyId: string, db?: Db): Promise<string> {
  return (await perfilEmpresa(companyId, db)).monedaCuenta;
}
