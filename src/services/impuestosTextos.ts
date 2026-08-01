import { FichaModeloImpuesto } from '../domain/impuestosModulo.model';

/**
 * Fichas explicativas por modelo (texto + advertencias + recomendaciones), como
 * la cabecera informativa de cada modelo en el video de Quipu. Hoy viven en
 * codigo; TODO: moverlas a BD/tabla editable si se quieren personalizar por
 * asesoria.
 */
const FICHAS: Record<string, FichaModeloImpuesto> = {
  '303': {
    modeloCodigo: '303',
    titulo: 'Modelo 303 — Autoliquidacion de IVA',
    textoExplicativo:
      'Declara el IVA repercutido en tus ventas (devengado) y el IVA soportado deducible de tus compras del periodo. El resultado es la diferencia: si es positivo se ingresa; si es negativo puedes compensarlo en periodos siguientes (casilla 78) o pedir devolucion en el 4T.',
    advertencias: [
      'Si editas a mano una casilla que forma parte de una suma (ej. una base del bloque devengado), recalcula TU los totales dependientes: el sistema no lo hace automaticamente.',
      'Pulsar "Recalcular importes" sobrescribe cualquier cambio manual.',
      'Las operaciones intracomunitarias y exportaciones NO devengan IVA aqui: van en las casillas informativas 59/60 (pagina 3).',
    ],
    notasConfiguracion: [
      'NIF e IBAN se toman de la configuracion de la empresa (FacturaScripts + cuentas bancarias).',
      'Recargo de equivalencia: configura las subcuentas 4775xx en reglas contables.',
      'OSS/ventanilla unica: TODO, no soportado en el autorrelleno actual.',
    ],
    recomendaciones: [
      'Antes de presentar, exporta el Excel de ingresos y gastos del trimestre y revisa que no falte ni sobre ninguna factura.',
      'Corrige los errores en la factura/ticket origen y vuelve a pulsar "Recalcular importes".',
    ],
  },
  '390': {
    modeloCodigo: '390',
    titulo: 'Modelo 390 — Resumen anual de IVA',
    textoExplicativo:
      'Resumen informativo anual de todas las autoliquidaciones de IVA (303) del ejercicio. No se ingresa nada: debe cuadrar con la suma de los cuatro trimestres.',
    advertencias: ['Si rectificaste algun 303, el 390 debe reflejar los importes definitivos.'],
    notasConfiguracion: ['Exonerados de 390 (SII, arrendadores...) deben marcar la casilla correspondiente en el 4T del 303 (TODO).'],
    recomendaciones: ['Genera primero los cuatro 303 y comprueba que la suma coincide con el resumen anual.'],
  },
  '347': {
    modeloCodigo: '347',
    titulo: 'Modelo 347 — Operaciones con terceros',
    textoExplicativo:
      'Declaracion informativa anual de clientes y proveedores con los que superaste 3.005,06 EUR (IVA incluido) durante el ejercicio. Se presenta en febrero.',
    advertencias: ['Los importes se declaran desglosados por trimestre ante discrepancias con la otra parte (TODO: desglose trimestral).'],
    notasConfiguracion: ['Los terceros se identifican por NIF: revisa que las fichas de cliente/proveedor tengan cifnif correcto.'],
    recomendaciones: ['Cruza los importes con tus clientes/proveedores antes de presentar para evitar requerimientos.'],
  },
  '349': {
    modeloCodigo: '349',
    titulo: 'Modelo 349 — Operaciones intracomunitarias',
    textoExplicativo:
      'Declaracion informativa de entregas (clave E) y adquisiciones (clave A) intracomunitarias. Las operaciones se detectan por el pais del tercero o el prefijo de su NIF-IVA.',
    advertencias: ['El operador debe estar dado de alta en el ROI/VIES; valida su NIF-IVA antes de facturar sin IVA.'],
    notasConfiguracion: ['Configura el codpais en la ficha del cliente/proveedor para una clasificacion correcta.'],
    recomendaciones: ['Si el 349 sale vacio pero tienes ventas UE, revisa el pais/NIF de las fichas de cliente.'],
  },
  '111': {
    modeloCodigo: '111',
    titulo: 'Modelo 111 — Retenciones IRPF',
    textoExplicativo:
      'Ingresa las retenciones de IRPF practicadas en el periodo: nominas de trabajadores (rendimientos del trabajo) y facturas de profesionales con retencion (actividades economicas).',
    advertencias: ['Las facturas de profesionales con IRPF alimentan este modelo automaticamente: no las dupliques a mano.'],
    notasConfiguracion: ['Las retenciones de compras se leen del campo IRPF de cada factura de proveedor.'],
    recomendaciones: ['Cuadra el total con el saldo de la subcuenta 4751 antes de presentar.'],
  },
  '115': {
    modeloCodigo: '115',
    titulo: 'Modelo 115 — Retenciones por alquileres',
    textoExplicativo:
      'Ingresa las retenciones practicadas en los alquileres de inmuebles urbanos (locales, oficinas) que pagas como inquilino.',
    advertencias: ['TODO: el autorrelleno de alquileres requiere marcar las facturas de arrendamiento; hoy devuelve ceros.'],
    notasConfiguracion: ['El arrendador debe facilitarte su NIF y el porcentaje de retencion vigente (19%).'],
    recomendaciones: ['Cuadra con el resumen anual 180 a fin de ejercicio.'],
  },
  '200': {
    modeloCodigo: '200',
    titulo: 'Modelo 200 — Impuesto sobre Sociedades',
    textoExplicativo:
      'Liquidacion anual del IS sobre el resultado contable ajustado. Se presenta en los 25 dias siguientes a los 6 meses del cierre (25 de julio para cierre 31/12).',
    advertencias: ['El TXT actual cubre la pagina de identificacion; las paginas de liquidacion completas son TODO.'],
    notasConfiguracion: ['Tipo aplicado: 25% (TODO: tipo reducido microempresas/startups, ajustes extracontables, BINs).'],
    recomendaciones: ['Cierra el ejercicio (regularizacion) antes de autorrellenar para que el resultado sea definitivo.'],
  },
};

export function fichaModelo(codigo: string): FichaModeloImpuesto {
  return (
    FICHAS[codigo] ?? {
      modeloCodigo: codigo,
      titulo: `Modelo ${codigo}`,
      textoExplicativo: 'Sin ficha explicativa para este modelo.',
      advertencias: [],
      notasConfiguracion: [],
      recomendaciones: [],
    }
  );
}
