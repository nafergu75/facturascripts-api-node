export interface GrupoCuenta {
  codigo: string; // '1'..'7'
  nombre: string;
}

export interface SubgrupoCuenta {
  codigo: string; // '10', '43', '57', '70', '705'...
  nombre: string;
  grupoCodigo: string;
}

export type TipoCuenta = 'activo' | 'pasivo' | 'patrimonio_neto' | 'ingreso' | 'gasto';

export interface CuentaContableBase {
  codigo: string; // '430', '700', '572'...
  nombre: string;
  subgrupoCodigo: string;
  tipo: TipoCuenta;
}

export interface SubcuentaEmpresa {
  id: string;
  companyId: string;
  codigo: string; // '4300001', '7000003'...
  nombre: string;
  cuentaBaseCodigo: string; // referencia a CuentaContableBase.codigo
  activa: boolean;
  analitica?: string;
  creadoEn: string;
  actualizadoEn: string;
}
