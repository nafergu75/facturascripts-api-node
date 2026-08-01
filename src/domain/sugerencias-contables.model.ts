export interface SugerenciaSubcuenta {
  codigoPropuesto: string; // '4300001', '7000003'...
  nombrePropuesto: string;
  cuentaBaseCodigo: string; // '430', '700'...
  motivo: string;
}

export interface DatosNuevoTercero {
  tipo: 'cliente' | 'proveedor';
  nombre: string;
  nif: string;
  actividad?: string;
}

export interface DatosNuevaFamiliaProducto {
  codigo: string;
  nombre: string;
  tipo: 'mercaderia' | 'servicio' | 'otro';
}
