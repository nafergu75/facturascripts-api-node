/**
 * Contenido de un registro de VERI*FACTU tal como se congela en
 * VerifactuRegistro.contenido (spec verifactu, 3.3). Todo va como TEXTO EXACTO
 * (services/verifactu/formato.ts): la fase F2 monta el XML de aqui sin volver a
 * leer la factura, y la huella se recalcula con estos mismos textos.
 *
 * Orden y nombres: RegistroFacturacionAltaType de SuministroInformacion.xsd
 * (tikeV1.0) y DsRegistroVeriFactu.xlsx v1.0.
 */

/** L8A (IVA): 01 general, 02 exportacion, 07 criterio de caja, 08 operaciones sujetas al IGIC/IPSI (servicios localizados en Canarias, Ceuta y Melilla). */
export type ClaveRegimen = '01' | '02' | '07' | '08';
/** L9: S1 sujeta no exenta, S2 sujeta con inversion del sujeto pasivo, N1/N2 no sujetas. */
export type CalificacionOperacion = 'S1' | 'S2' | 'N1' | 'N2';
/** L10 */
export type OperacionExenta = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6';
/** L7: 02 NIF-IVA, 03 pasaporte, 04 documento oficial del pais de residencia, 05 certificado de residencia, 06 otro, 07 no censado. */
export type IdType = '02' | '03' | '04' | '05' | '06' | '07';

/** Una linea de Desglose/DetalleDesglose (orden del XSD). */
export interface DetalleDesglose {
  /** 01 = IVA (se informa siempre). */
  impuesto: '01';
  claveRegimen: ClaveRegimen;
  /** Excluyente con operacionExenta. */
  calificacionOperacion?: CalificacionOperacion;
  operacionExenta?: OperacionExenta;
  /** Solo S1 y S2 (en S2, «0.00»). */
  tipoImpositivo?: string;
  /** BaseImponibleOimporteNoSujeto */
  baseImponible: string;
  /** Solo S1 y S2 (en S2, «0.00»). */
  cuotaRepercutida?: string;
}

export interface IdOtro {
  /** ISO 3166-1 alfa-2 (CountryType2; Irlanda del Norte va como GB). No exigible con IDType 02. */
  codigoPais?: string;
  idType: IdType;
  /** Como mucho 20 caracteres. */
  id: string;
}

/** Destinatarios/IDDestinatario: NombreRazon y NIF, o NombreRazon e IDOtro. */
export type Destinatario = { nombre: string; nif: string } | { nombre: string; idOtro: IdOtro };

/** FacturasRectificadas/IDFacturaRectificada. */
export interface FacturaRectificadaRef {
  idEmisor: string;
  numSerie: string;
  /** dd-mm-aaaa */
  fecha: string;
}

/** SistemaInformatico (constantes de services/verifactu/sistema.ts, congeladas en cada registro). */
export interface SistemaInformatico {
  nombreRazon: string;
  nif: string;
  nombreSistemaInformatico: string;
  idSistemaInformatico: string;
  version: string;
  numeroInstalacion: string;
  tipoUsoPosibleSoloVerifactu: 'S' | 'N';
  tipoUsoPosibleMultiOT: 'S' | 'N';
  indicadorMultiplesOT: 'S' | 'N';
}

/** Encadenamiento: PrimerRegistro=S o el registro anterior de la cadena (alta o anulacion). */
export type Encadenamiento =
  | { primerRegistro: true }
  | { registroAnterior: { idEmisor: string; numSerie: string; fecha: string; huella: string } };

/**
 * Lo que construye construirAlta a partir de la factura: el cuerpo del alta,
 * sin encadenamiento ni sistema informatico (los pone generarRegistroAlta con
 * la cadena bloqueada).
 */
export interface CuerpoAlta {
  /** IncomeInvoice.id (RefExterna, como mucho 60). */
  refExterna: string;
  nombreEmisor: string;
  tipoRectificativa?: 'S' | 'I';
  facturasRectificadas?: FacturaRectificadaRef[];
  importeRectificacion?: { base: string; cuota: string; cuotaRecargo?: string };
  /** dd-mm-aaaa, solo si es distinta de la de expedicion. */
  fechaOperacion?: string;
  descripcionOperacion: string;
  macrodato?: 'S';
  /** Ausente en F2 y R5. */
  destinatarios?: Destinatario[];
  desglose: DetalleDesglose[];
  /** Avisos de la construccion (p. ej. originales que no se pudieron citar). No van al XML. */
  avisos?: string[];
}

/** Contenido completo del registro de alta (VerifactuRegistro.contenido). */
export interface RegistroContenido extends CuerpoAlta {
  /** Version de esta forma de guardar el contenido. */
  version: 1;
  /** IDVersion del XSD. */
  idVersion: '1.0';
  /** 01 = SHA-256 (L12). */
  tipoHuella: '01';
  encadenamiento: Encadenamiento;
  sistemaInformatico: SistemaInformatico;
}

/** El alta lista para la huella y para validarla: los campos de la huella y el cuerpo. */
export interface AltaConstruida {
  /** IDFactura/IDEmisorFactura (= nifObligado de la configuracion). */
  idEmisor: string;
  /** IDFactura/NumSerieFactura (numeroCompleto). */
  numSerie: string;
  /** IDFactura/FechaExpedicionFactura (dd-mm-aaaa). */
  fechaExpedicion: string;
  tipoFactura: string;
  cuotaTotal: string;
  importeTotal: string;
  cuerpo: CuerpoAlta;
  /** Para validarAlta (no se guardan aparte): fechas AAAA-MM-DD y totales en centimos. */
  control: {
    fechaExpedicionIso: string;
    fechaOperacionIso: string | null;
    cuotaTotalCentimos: number;
    importeTotalCentimos: number;
    /** Tipo de cada linea del desglose como numero (S1 y S2). */
    tipos: Array<number | null>;
    /** Destinatario requerido y no identificable (cliente ES sin NIF valido, extranjero sin ID...). */
    problemaDestinatario: ProblemaDestinatario | null;
  };
}

/** Por que no se puede identificar al destinatario. */
export interface ProblemaDestinatario {
  codigo: 'VERIFACTU_CLIENTE_SIN_NIF' | 'VERIFACTU_CLIENTE_SIN_IDENTIFICACION' | 'VERIFACTU_ID_DESTINATARIO_LARGO';
  mensaje: string;
}
