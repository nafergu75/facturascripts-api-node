/**
 * UTILIDADES AEAT - Casillas y estructura de modelos fiscales
 *
 * Mapeo completo de casillas para:
 * - Modelo 303 (IVA Trimestral)
 * - Modelo 111 (Retenciones)
 * - Modelo 200 (Impuesto Sociedades)
 */

/**
 * MODELO 303: IVA TRIMESTRAL
 *
 * Estructura de casillas simplificada pero completa:
 * - Operaciones interiores (bases y cuotas)
 * - Entregas de bienes y servicios
 * - Operaciones sujetas a régimen especial
 * - Cálculo del IVA a ingresar/devolver
 */
export function generarCasillas303(datos: {
  baseRepercutido: number;
  cuotaRepercutido: number;
  baseSoportado: number;
  cuotaSoportado: number;
  resultado: number;
}): Record<string, any> {
  return {
    // Operaciones Interiores de Entregas de Bienes y Servicios
    '01': {
      numero: '01',
      descripcion: 'Base de operaciones con IVA (entregas de bienes)',
      valor: datos.baseRepercutido,
      tipo: 'base',
    },
    '02': {
      numero: '02',
      descripcion: 'IVA repercutido (cuota)',
      valor: datos.cuotaRepercutido,
      tipo: 'cuota',
    },

    // Operaciones Soportadas (Adquisiciones)
    '05': {
      numero: '05',
      descripcion: 'Base de adquisiciones de bienes y servicios',
      valor: datos.baseSoportado,
      tipo: 'base',
    },
    '06': {
      numero: '06',
      descripcion: 'IVA soportado (cuota)',
      valor: datos.cuotaSoportado,
      tipo: 'cuota',
    },

    // Operaciones Intracomunitarias (Simplificado)
    '09': {
      numero: '09',
      descripcion: 'Base de adquisiciones intracomunitarias',
      valor: 0,
      tipo: 'base',
    },
    '10': {
      numero: '10',
      descripcion: 'IVA sobre adquisiciones intracomunitarias',
      valor: 0,
      tipo: 'cuota',
    },

    // Cálculo Final
    '13': {
      numero: '13',
      descripcion: 'Resultado IVA (cuota a ingresar/devolver)',
      valor: Math.abs(datos.resultado),
      tipo: 'resultado',
    },
    '14': {
      numero: '14',
      descripcion: 'Tipo de resultado (1=ingresar, 0=devolver)',
      valor: datos.resultado > 0 ? 1 : 0,
      tipo: 'indicador',
    },

    // Campos adicionales para exportación
    totalRepercutido: datos.cuotaRepercutido,
    totalSoportado: datos.cuotaSoportado,
    resultadoFinal: datos.resultado,
  };
}

/**
 * MODELO 200: IMPUESTO DE SOCIEDADES (MVP)
 *
 * Estructura de casillas para cálculo de IS:
 * - Base imponible (resultado contable + ajustes)
 * - Cuota íntegra
 * - Deducciones
 * - Cuota líquida
 * - Retenciones practicadas
 */
export function generarCasillas200(datos: {
  resultadoContable: number;
  baseImponible: number;
  tipoImpositivo: number;
  cuotaIntegra: number;
  deducciones: number;
  cuotaLiquida: number;
  retencionesPracticadas?: number;
  anticiposPagados?: number;
}): Record<string, any> {
  const retencionesPracticadas = datos.retencionesPracticadas || 0;
  const anticiposPagados = datos.anticiposPagados || 0;

  // Cálculo de cuota a ingresar/devolver
  const cuotaAIngresar = Math.max(0, datos.cuotaLiquida - retencionesPracticadas - anticiposPagados);
  const cuotaADevolver = Math.max(0, retencionesPracticadas + anticiposPagados - datos.cuotaLiquida);

  return {
    // Base Imponible
    '001': {
      numero: '001',
      descripcion: 'Resultado contable del ejercicio',
      valor: datos.resultadoContable,
      tipo: 'base',
    },
    '002': {
      numero: '002',
      descripcion: 'Ajustes extracontables (incrementos)',
      valor: 0,
      tipo: 'ajuste',
    },
    '003': {
      numero: '003',
      descripcion: 'Ajustes extracontables (disminuciones)',
      valor: 0,
      tipo: 'ajuste',
    },
    '004': {
      numero: '004',
      descripcion: 'Rectificaciones de ejercicios anteriores',
      valor: 0,
      tipo: 'ajuste',
    },
    '010': {
      numero: '010',
      descripcion: 'Base imponible del período',
      valor: datos.baseImponible,
      tipo: 'base_final',
    },

    // Cálculo de Cuota
    '120': {
      numero: '120',
      descripcion: 'Cuota íntegra (base × tipo)',
      valor: datos.cuotaIntegra,
      tipo: 'cuota_integra',
      formula: `${datos.baseImponible} × ${datos.tipoImpositivo}%`,
    },

    // Deducciones
    '140': {
      numero: '140',
      descripcion: 'Deducciones (inversión, I+D, etc.)',
      valor: datos.deducciones,
      tipo: 'deduccion',
    },

    // Cuota Líquida
    '145': {
      numero: '145',
      descripcion: 'Cuota líquida (cuota íntegra - deducciones)',
      valor: datos.cuotaLiquida,
      tipo: 'cuota_liquida',
    },

    // Retenciones y Anticipos
    '190': {
      numero: '190',
      descripcion: 'Retenciones practicadas',
      valor: retencionesPracticadas,
      tipo: 'retencion',
    },
    '191': {
      numero: '191',
      descripcion: 'Anticipos pagados (pago fraccionado)',
      valor: anticiposPagados,
      tipo: 'anticipo',
    },

    // Resultado Final
    '200': {
      numero: '200',
      descripcion: 'Cuota a ingresar',
      valor: cuotaAIngresar,
      tipo: 'resultado_ingresar',
    },
    '201': {
      numero: '201',
      descripcion: 'Cuota a devolver',
      valor: cuotaADevolver,
      tipo: 'resultado_devolver',
    },

    // Resumen
    tipoCuota: datos.tipoImpositivo,
    resumen: {
      resultadoContable: datos.resultadoContable,
      baseImponible: datos.baseImponible,
      cuotaIntegra: datos.cuotaIntegra,
      deducciones: datos.deducciones,
      cuotaLiquida: datos.cuotaLiquida,
      retencionesPracticadas,
      anticiposPagados,
      cuotaAIngresar,
      cuotaADevolver,
    },
  };
}

/**
 * MODELO 347: OPERACIONES CON TERCEROS (ANUAL)
 *
 * Estructura para operaciones con terceros superiores a 3.000,06€:
 * - Clientes (facturas de ingreso)
 * - Proveedores (facturas de gasto)
 * - Otros terceros
 */
export function generarCasillas347(datos: {
  terceros: Array<{
    nif: string;
    nombre: string;
    tipoTercero: 'cliente' | 'proveedor' | 'otro';
    operaciones: Array<{
      tipoOperacion: string;
      importe: number;
      trimestre?: number;
    }>;
    totalOperaciones: number;
  }>;
  totalTerceros: number;
}): Record<string, any> {
  const casillas: Record<string, any> = {};

  // Casilla 01: Total de terceros reportados
  casillas['01'] = {
    numero: '01',
    descripcion: 'Número total de terceros',
    valor: datos.terceros.length,
    tipo: 'count',
  };

  // Casilla 02: Importe total de operaciones
  casillas['02'] = {
    numero: '02',
    descripcion: 'Importe total de operaciones',
    valor: datos.totalTerceros,
    tipo: 'total',
  };

  // Desglose por tercero (casillas 03-99 para cada tercero, simulado)
  let casillaIndex = 3;
  const tercerosCasillas: Record<string, any> = {};

  for (const tercero of datos.terceros) {
    tercerosCasillas[`tercero_${casillaIndex}`] = {
      index: casillaIndex,
      nif: tercero.nif,
      nombre: tercero.nombre,
      tipoTercero: tercero.tipoTercero,
      totalOperaciones: tercero.totalOperaciones,
      operacionesPorTipo: tercero.operaciones.reduce((acc, op) => {
        acc[op.tipoOperacion] = (acc[op.tipoOperacion] || 0) + op.importe;
        return acc;
      }, {} as Record<string, number>),
    };
    casillaIndex++;
  }

  return {
    ...casillas,
    terceros: tercerosCasillas,
    tercerosList: datos.terceros,
    totalTerceros: datos.terceros.length,
    totalImportes: datos.totalTerceros,
    detalleOperaciones: datos.terceros.map((t) => ({
      nif: t.nif,
      nombre: t.nombre,
      tipo: t.tipoTercero,
      importe: t.totalOperaciones,
      operaciones: t.operaciones.length,
    })),
  };
}

/**
 * MODELO 390: RESUMEN ANUAL DE IVA
 *
 * Consolidación de los 4 trimestres en resumen anual:
 * - Totales anuales de IVA repercutido y soportado
 * - Resultado anual (a ingresar/devolver)
 * - Desglose trimestral
 */
export function generarCasillas390(datos: {
  trimestres: Array<{
    numero: number; // 1-4
    baseRepercutido: number;
    cuotaRepercutido: number;
    baseSoportado: number;
    cuotaSoportado: number;
    resultado: number;
  }>;
  totalBaseRepercutido: number;
  totalCuotaRepercutido: number;
  totalBaseSoportado: number;
  totalCuotaSoportado: number;
  resultadoAnual: number;
}): Record<string, any> {
  const casillas: Record<string, any> = {};

  // Casillas anuales
  casillas['01'] = {
    numero: '01',
    descripcion: 'Base de operaciones con IVA (entregas de bienes) – Total anual',
    valor: datos.totalBaseRepercutido,
    tipo: 'base',
  };

  casillas['02'] = {
    numero: '02',
    descripcion: 'IVA repercutido – Total anual',
    valor: datos.totalCuotaRepercutido,
    tipo: 'cuota',
  };

  casillas['05'] = {
    numero: '05',
    descripcion: 'Base de adquisiciones de bienes y servicios – Total anual',
    valor: datos.totalBaseSoportado,
    tipo: 'base',
  };

  casillas['06'] = {
    numero: '06',
    descripcion: 'IVA soportado – Total anual',
    valor: datos.totalCuotaSoportado,
    tipo: 'cuota',
  };

  // Resultado
  casillas['13'] = {
    numero: '13',
    descripcion: 'Resultado IVA anual (cuota a ingresar/devolver)',
    valor: Math.abs(datos.resultadoAnual),
    tipo: 'resultado',
  };

  casillas['14'] = {
    numero: '14',
    descripcion: 'Tipo de resultado (1=ingresar, 0=devolver)',
    valor: datos.resultadoAnual > 0 ? 1 : 0,
    tipo: 'indicador',
  };

  // Desglose por trimestre (casillas 99-106 para Q1-Q4)
  const desgloseTrimestrales = datos.trimestres.map((t, idx) => ({
    [`T${t.numero}_01`]: {
      numero: `T${t.numero}_01`,
      descripcion: `Base repercutido Q${t.numero}`,
      valor: t.baseRepercutido,
    },
    [`T${t.numero}_02`]: {
      numero: `T${t.numero}_02`,
      descripcion: `Cuota repercutido Q${t.numero}`,
      valor: t.cuotaRepercutido,
    },
    [`T${t.numero}_05`]: {
      numero: `T${t.numero}_05`,
      descripcion: `Base soportado Q${t.numero}`,
      valor: t.baseSoportado,
    },
    [`T${t.numero}_06`]: {
      numero: `T${t.numero}_06`,
      descripcion: `Cuota soportado Q${t.numero}`,
      valor: t.cuotaSoportado,
    },
    [`T${t.numero}_13`]: {
      numero: `T${t.numero}_13`,
      descripcion: `Resultado Q${t.numero}`,
      valor: Math.abs(t.resultado),
    },
  }));

  return {
    ...casillas,
    trimestres: desgloseTrimestrales,
    resumen: {
      totalRepercutido: datos.totalCuotaRepercutido,
      totalSoportado: datos.totalCuotaSoportado,
      resultadoFinal: datos.resultadoAnual,
      desgloseTrimestral: datos.trimestres.map((t) => ({
        trimestre: t.numero,
        baseRepercutido: t.baseRepercutido,
        cuotaRepercutido: t.cuotaRepercutido,
        baseSoportado: t.baseSoportado,
        cuotaSoportado: t.cuotaSoportado,
        resultado: t.resultado,
      })),
    },
  };
}

/**
 * Estructura de metadata para auditoría de modelos fiscales
 * Compatible con Prisma JSON fields
 */
export type ModeloFiscalAuditoria = Record<string, any> & {
  generadoPor: string; // userId
  generadoEn: string; // ISO timestamp
  marcadoPresentadoPor?: string; // userId
  marcadoPresentadoEn?: string; // ISO timestamp
  justificante?: {
    numero: string;
    fecha: string;
  };
  origen: 'autorrelleno' | 'manual-mixto' | 'importado';
  version: string; // versión del modelo (ej. '2025.0A')
};
