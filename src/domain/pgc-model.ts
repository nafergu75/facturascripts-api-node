/**
 * Plan General de Contabilidad (PGC) - PYME
 * Modelo jerárquico: Grupo → Subgrupo → Cuenta → Subcuenta
 * Con soporte para edición/creación de elementos de usuario respetando PGC base.
 */

export type PgcType = 'activo' | 'pasivo' | 'patrimonio_neto' | 'gasto' | 'ingreso';
export type PgcLevel = 'group' | 'subgroup' | 'account' | 'subaccount';

export interface PgcBaseNode {
  code: string; // "6", "62", "621", "6210001"
  codigo?: string; // Alias para compatibilidad
  name: string; // "Compras de mercaderías"
  nombre?: string; // Alias para compatibilidad
  type: PgcType;
  tipo?: string; // Alias para compatibilidad
  isSystem: boolean; // true = forma parte del PGC base, no se puede borrar
  isEditable: boolean; // true = permite añadir subniveles (subgrupos/subcuentas) de usuario
  parentCode?: string | null;
  level: PgcLevel;
}

export interface PgcGroup extends PgcBaseNode {
  level: 'group';
  // code: "1"..."7"
}

export interface PgcSubgroup extends PgcBaseNode {
  level: 'subgroup';
  groupCode: string; // "1"..."7"
  grupoCodigo?: string; // Alias para compatibilidad
  // code: "10","11","60","62","64","70", etc.
}

export interface PgcAccount extends PgcBaseNode {
  level: 'account';
  groupCode: string; // "1"..."7"
  subgroupCode: string; // "10","11","60","62", etc.
  subgrupoCodigo?: string; // Alias para compatibilidad
  // code: "100","170","520","600","621","640","700", etc.
}

export interface PgcSubaccount extends PgcBaseNode {
  level: 'subaccount';
  groupCode: string; // "1"..."7"
  subgroupCode: string; // "10","11","60","62", etc.
  accountCode: string; // "600","621","640", etc.
  // code: "600001","640001", etc.
}

export type PgcNode = PgcGroup | PgcSubgroup | PgcAccount | PgcSubaccount;

/**
 * Seed: Plan General de Contabilidad PYME base
 * Incluye grupos 1-7 con nuevas cuentas de nóminas, préstamos y leasing.
 */
const PGC_NODOS: PgcNode[] = [
  // === GRUPO 1: Financiación básica ===
  {
    level: 'group',
    code: '1',
    name: 'Financiación básica',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,

  // Subgrupo 10 - Capital
  {
    level: 'subgroup',
    code: '10',
    groupCode: '1',
    name: 'Capital',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: false,
    parentCode: '1',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '100',
    groupCode: '1',
    subgroupCode: '10',
    name: 'Capital social',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: true,
    parentCode: '10',
  } as PgcAccount,
  {
    level: 'account',
    code: '101',
    groupCode: '1',
    subgroupCode: '10',
    name: 'Fondo social',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: true,
    parentCode: '10',
  } as PgcAccount,

  // Subgrupo 11 - Reservas
  {
    level: 'subgroup',
    code: '11',
    groupCode: '1',
    name: 'Reservas',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: false,
    parentCode: '1',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '110',
    groupCode: '1',
    subgroupCode: '11',
    name: 'Prima de emisión',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: true,
    parentCode: '11',
  } as PgcAccount,
  {
    level: 'account',
    code: '113',
    groupCode: '1',
    subgroupCode: '11',
    name: 'Reservas voluntarias',
    type: 'patrimonio_neto',
    isSystem: true,
    isEditable: true,
    parentCode: '11',
  } as PgcAccount,

  // Subgrupo 17 - Deudas a largo plazo
  {
    level: 'subgroup',
    code: '17',
    groupCode: '1',
    name: 'Deudas a largo plazo',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '1',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '170',
    groupCode: '1',
    subgroupCode: '17',
    name: 'Deudas a largo plazo con entidades de crédito',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '17',
  } as PgcAccount,
  {
    level: 'account',
    code: '174',
    groupCode: '1',
    subgroupCode: '17',
    name: 'Acreedores por arrendamiento financiero a largo plazo',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '17',
  } as PgcAccount,

  // === GRUPO 2: Activo no corriente ===
  {
    level: 'group',
    code: '2',
    name: 'Activo no corriente',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,
  {
    level: 'subgroup',
    code: '20',
    groupCode: '2',
    name: 'Inmovilizaciones intangibles',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '2',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '200',
    groupCode: '2',
    subgroupCode: '20',
    name: 'Inmovilizado intangible',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '20',
  } as PgcAccount,
  {
    level: 'subgroup',
    code: '21',
    groupCode: '2',
    name: 'Inmovilizaciones materiales',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '2',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '210',
    groupCode: '2',
    subgroupCode: '21',
    name: 'Terrenos y bienes naturales',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '21',
  } as PgcAccount,
  {
    level: 'account',
    code: '220',
    groupCode: '2',
    subgroupCode: '22',
    name: 'Inversiones en terrenos y bienes naturales',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '22',
  } as PgcAccount,
  {
    level: 'subgroup',
    code: '28',
    groupCode: '2',
    name: 'Amortización acumulada del inmovilizado',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '2',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '280',
    groupCode: '2',
    subgroupCode: '28',
    name: 'Amortización acumulada del inmovilizado intangible',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '28',
  } as PgcAccount,

  // === GRUPO 3: Existencias ===
  {
    level: 'group',
    code: '3',
    name: 'Existencias',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,
  {
    level: 'subgroup',
    code: '30',
    groupCode: '3',
    name: 'Existencias comerciales',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '3',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '300',
    groupCode: '3',
    subgroupCode: '30',
    name: 'Mercaderías',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '30',
  } as PgcAccount,

  // === GRUPO 4: Acreedores y deudores (incl. nóminas/SS) ===
  {
    level: 'group',
    code: '4',
    name: 'Acreedores y deudores por operaciones comerciales',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,

  // Subgrupo 40 - Proveedores
  {
    level: 'subgroup',
    code: '40',
    groupCode: '4',
    name: 'Proveedores',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '4',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '400',
    groupCode: '4',
    subgroupCode: '40',
    name: 'Proveedores',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '40',
  } as PgcAccount,

  // Subgrupo 41 - Acreedores varios
  {
    level: 'subgroup',
    code: '41',
    groupCode: '4',
    name: 'Acreedores varios',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '4',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '410',
    groupCode: '4',
    subgroupCode: '41',
    name: 'Acreedores por prestaciones de servicios',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '41',
  } as PgcAccount,

  // Subgrupo 43 - Clientes
  {
    level: 'subgroup',
    code: '43',
    groupCode: '4',
    name: 'Clientes',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '4',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '430',
    groupCode: '4',
    subgroupCode: '43',
    name: 'Clientes',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '43',
  } as PgcAccount,

  // Subgrupo 44 - Deudores varios
  {
    level: 'subgroup',
    code: '44',
    groupCode: '4',
    name: 'Deudores varios',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '4',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '440',
    groupCode: '4',
    subgroupCode: '44',
    name: 'Deudores',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '44',
  } as PgcAccount,

  // Subgrupo 46 - Personal (NÓMINAS)
  {
    level: 'subgroup',
    code: '46',
    groupCode: '4',
    name: 'Personal',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '4',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '465',
    groupCode: '4',
    subgroupCode: '46',
    name: 'Remuneraciones pendientes de pago',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '46',
  } as PgcAccount,

  // Subgrupo 47 - Administraciones públicas
  {
    level: 'subgroup',
    code: '47',
    groupCode: '4',
    name: 'Administraciones públicas',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '4',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '470',
    groupCode: '4',
    subgroupCode: '47',
    name: 'Hacienda Pública, deudora por diversos conceptos',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '47',
  } as PgcAccount,
  {
    level: 'account',
    code: '472',
    groupCode: '4',
    subgroupCode: '47',
    name: 'Hacienda Pública, IVA soportado',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '47',
  } as PgcAccount,
  {
    level: 'account',
    code: '475',
    groupCode: '4',
    subgroupCode: '47',
    name: 'Hacienda Pública, acreedora por conceptos fiscales',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '47',
  } as PgcAccount,
  {
    level: 'account',
    code: '476',
    groupCode: '4',
    subgroupCode: '47',
    name: 'Organismos de la Seguridad Social, acreedores',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '47',
  } as PgcAccount,
  {
    level: 'account',
    code: '477',
    groupCode: '4',
    subgroupCode: '47',
    name: 'Hacienda Pública, IVA repercutido',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '47',
  } as PgcAccount,

  // === GRUPO 5: Cuentas financieras (incl. préstamos/leasing) ===
  {
    level: 'group',
    code: '5',
    name: 'Cuentas financieras',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,

  // Subgrupo 52 - Deudas a corto plazo (PRÉSTAMOS y LEASING)
  {
    level: 'subgroup',
    code: '52',
    groupCode: '5',
    name: 'Deudas a corto plazo',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '5',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '520',
    groupCode: '5',
    subgroupCode: '52',
    name: 'Deudas a corto plazo con entidades de crédito',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '52',
  } as PgcAccount,
  {
    level: 'account',
    code: '524',
    groupCode: '5',
    subgroupCode: '52',
    name: 'Acreedores por arrendamiento financiero a corto plazo',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '52',
  } as PgcAccount,

  // Subgrupo 55 - Otras cuentas no bancarias
  {
    level: 'subgroup',
    code: '55',
    groupCode: '5',
    name: 'Otras cuentas no bancarias',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '5',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '551',
    groupCode: '5',
    subgroupCode: '55',
    name: 'Cuenta corriente con socios y administradores',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '55',
  } as PgcAccount,

  // Subgrupo 56 - Fianzas y depósitos recibidos
  {
    level: 'subgroup',
    code: '56',
    groupCode: '5',
    name: 'Fianzas y depósitos recibidos',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '5',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '560',
    groupCode: '5',
    subgroupCode: '56',
    name: 'Fianzas recibidas a corto plazo',
    type: 'pasivo',
    isSystem: true,
    isEditable: true,
    parentCode: '56',
  } as PgcAccount,

  // Subgrupo 57 - Tesorería
  {
    level: 'subgroup',
    code: '57',
    groupCode: '5',
    name: 'Tesorería',
    type: 'activo',
    isSystem: true,
    isEditable: false,
    parentCode: '5',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '570',
    groupCode: '5',
    subgroupCode: '57',
    name: 'Caja, euros',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '57',
  } as PgcAccount,
  {
    level: 'account',
    code: '572',
    groupCode: '5',
    subgroupCode: '57',
    name: 'Bancos e instituciones de crédito c/c vista, euros',
    type: 'activo',
    isSystem: true,
    isEditable: true,
    parentCode: '57',
  } as PgcAccount,

  // === GRUPO 6: Compras y gastos (incl. nóminas) ===
  {
    level: 'group',
    code: '6',
    name: 'Compras y gastos',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,

  // Subgrupo 60 - Compras
  {
    level: 'subgroup',
    code: '60',
    groupCode: '6',
    name: 'Compras',
    type: 'gasto',
    isSystem: true,
    isEditable: false,
    parentCode: '6',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '600',
    groupCode: '6',
    subgroupCode: '60',
    name: 'Compras de mercaderías',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '60',
  } as PgcAccount,
  {
    level: 'account',
    code: '602',
    groupCode: '6',
    subgroupCode: '60',
    name: 'Compras de otros aprovisionamientos',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '60',
  } as PgcAccount,

  // Subgrupo 62 - Servicios exteriores (incl. arrendamientos)
  {
    level: 'subgroup',
    code: '62',
    groupCode: '6',
    name: 'Servicios exteriores',
    type: 'gasto',
    isSystem: true,
    isEditable: false,
    parentCode: '6',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '621',
    groupCode: '6',
    subgroupCode: '62',
    name: 'Arrendamientos y cánones',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '62',
  } as PgcAccount,
  {
    level: 'account',
    code: '622',
    groupCode: '6',
    subgroupCode: '62',
    name: 'Reparaciones y conservación',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '62',
  } as PgcAccount,
  {
    level: 'account',
    code: '626',
    groupCode: '6',
    subgroupCode: '62',
    name: 'Servicios bancarios y similares',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '62',
  } as PgcAccount,
  {
    level: 'account',
    code: '627',
    groupCode: '6',
    subgroupCode: '62',
    name: 'Publicidad, propaganda y relaciones públicas',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '62',
  } as PgcAccount,
  {
    level: 'account',
    code: '628',
    groupCode: '6',
    subgroupCode: '62',
    name: 'Suministros',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '62',
  } as PgcAccount,
  {
    level: 'account',
    code: '629',
    groupCode: '6',
    subgroupCode: '62',
    name: 'Otros servicios',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '62',
  } as PgcAccount,

  // Subgrupo 64 - Gastos de personal (NÓMINAS y SS)
  {
    level: 'subgroup',
    code: '64',
    groupCode: '6',
    name: 'Gastos de personal',
    type: 'gasto',
    isSystem: true,
    isEditable: false,
    parentCode: '6',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '640',
    groupCode: '6',
    subgroupCode: '64',
    name: 'Sueldos y salarios',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '64',
  } as PgcAccount,
  {
    level: 'account',
    code: '641',
    groupCode: '6',
    subgroupCode: '64',
    name: 'Indemnizaciones',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '64',
  } as PgcAccount,
  {
    level: 'account',
    code: '642',
    groupCode: '6',
    subgroupCode: '64',
    name: 'Seguridad Social a cargo de la empresa',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '64',
  } as PgcAccount,
  {
    level: 'account',
    code: '649',
    groupCode: '6',
    subgroupCode: '64',
    name: 'Otros gastos sociales',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '64',
  } as PgcAccount,

  // Subgrupo 68 - Dotaciones para amortizaciones
  {
    level: 'subgroup',
    code: '68',
    groupCode: '6',
    name: 'Dotaciones para amortizaciones',
    type: 'gasto',
    isSystem: true,
    isEditable: false,
    parentCode: '6',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '680',
    groupCode: '6',
    subgroupCode: '68',
    name: 'Amortización del inmovilizado intangible',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '68',
  } as PgcAccount,
  {
    level: 'account',
    code: '681',
    groupCode: '6',
    subgroupCode: '68',
    name: 'Amortización del inmovilizado material',
    type: 'gasto',
    isSystem: true,
    isEditable: true,
    parentCode: '68',
  } as PgcAccount,

  // === GRUPO 7: Ventas e ingresos ===
  {
    level: 'group',
    code: '7',
    name: 'Ventas e ingresos',
    type: 'ingreso',
    isSystem: true,
    isEditable: true,
    parentCode: null,
  } as PgcGroup,

  // Subgrupo 70 - Ventas de mercaderías y prestación de servicios
  {
    level: 'subgroup',
    code: '70',
    groupCode: '7',
    name: 'Ventas de mercaderías y prestación de servicios',
    type: 'ingreso',
    isSystem: true,
    isEditable: false,
    parentCode: '7',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '700',
    groupCode: '7',
    subgroupCode: '70',
    name: 'Ventas de mercaderías',
    type: 'ingreso',
    isSystem: true,
    isEditable: true,
    parentCode: '70',
  } as PgcAccount,
  {
    level: 'account',
    code: '705',
    groupCode: '7',
    subgroupCode: '70',
    name: 'Prestaciones de servicios',
    type: 'ingreso',
    isSystem: true,
    isEditable: true,
    parentCode: '70',
  } as PgcAccount,

  // Subgrupo 76 - Ingresos financieros
  {
    level: 'subgroup',
    code: '76',
    groupCode: '7',
    name: 'Ingresos financieros',
    type: 'ingreso',
    isSystem: true,
    isEditable: false,
    parentCode: '7',
  } as PgcSubgroup,
  {
    level: 'account',
    code: '769',
    groupCode: '7',
    subgroupCode: '76',
    name: 'Otros ingresos financieros',
    type: 'ingreso',
    isSystem: true,
    isEditable: true,
    parentCode: '76',
  } as PgcAccount,
];

// ==== Ampliacion del plan base (PGC PYMES, RD 1515/2007) ====
// Cuentas que usa el motor contable y que faltaban (473, 555, 623, 701, 702...),
// y las de compras, gastos e ingresos de los grupos 6 y 7 para poder asignar
// una factura a su cuenta. Nombres segun el cuadro de cuentas oficial.

function subgrupo(code: string, name: string, type: PgcType): PgcSubgroup {
  return { level: 'subgroup', code, groupCode: code[0], name, type, isSystem: true, isEditable: false, parentCode: code[0] };
}

function cuenta(code: string, name: string, type: PgcType): PgcAccount {
  return {
    level: 'account',
    code,
    groupCode: code[0],
    subgroupCode: code.slice(0, 2),
    name,
    type,
    isSystem: true,
    isEditable: true,
    parentCode: code.slice(0, 2),
  };
}

const PGC_AMPLIACION: PgcNode[] = [
  // Grupo 1
  subgrupo('12', 'Resultados pendientes de aplicación', 'patrimonio_neto'),
  cuenta('120', 'Remanente', 'patrimonio_neto'),
  cuenta('121', 'Resultados negativos de ejercicios anteriores', 'patrimonio_neto'),
  cuenta('129', 'Resultado del ejercicio', 'patrimonio_neto'),
  // Grupo 2
  subgrupo('22', 'Inversiones inmobiliarias', 'activo'),
  cuenta('221', 'Inversiones en construcciones', 'activo'),
  // Grupo 4
  cuenta('473', 'Hacienda Pública, retenciones y pagos a cuenta', 'activo'),
  // El motor contable lleva aqui el IRPF que retenemos en las compras.
  {
    level: 'subaccount',
    code: '4751',
    groupCode: '4',
    subgroupCode: '47',
    accountCode: '475',
    name: 'Hacienda Pública, acreedora por retenciones practicadas',
    type: 'pasivo',
    isSystem: true,
    isEditable: false,
    parentCode: '475',
  },
  // Grupo 5
  cuenta('555', 'Partidas pendientes de aplicación', 'activo'),
  // Grupo 6
  cuenta('601', 'Compras de materias primas', 'gasto'),
  cuenta('606', 'Descuentos sobre compras por pronto pago', 'gasto'),
  cuenta('607', 'Trabajos realizados por otras empresas', 'gasto'),
  cuenta('608', 'Devoluciones de compras y operaciones similares', 'gasto'),
  cuenta('609', 'Rappels por compras', 'gasto'),
  subgrupo('61', 'Variación de existencias', 'gasto'),
  cuenta('610', 'Variación de existencias de mercaderías', 'gasto'),
  cuenta('620', 'Gastos en investigación y desarrollo del ejercicio', 'gasto'),
  cuenta('623', 'Servicios de profesionales independientes', 'gasto'),
  cuenta('624', 'Transportes', 'gasto'),
  cuenta('625', 'Primas de seguros', 'gasto'),
  subgrupo('63', 'Tributos', 'gasto'),
  cuenta('630', 'Impuesto sobre beneficios', 'gasto'),
  cuenta('631', 'Otros tributos', 'gasto'),
  cuenta('634', 'Ajustes negativos en la imposición indirecta', 'gasto'),
  cuenta('636', 'Devolución de impuestos', 'gasto'),
  subgrupo('65', 'Otros gastos de gestión', 'gasto'),
  cuenta('650', 'Pérdidas de créditos comerciales incobrables', 'gasto'),
  cuenta('659', 'Otras pérdidas en gestión corriente', 'gasto'),
  subgrupo('66', 'Gastos financieros', 'gasto'),
  cuenta('662', 'Intereses de deudas', 'gasto'),
  cuenta('665', 'Intereses por descuento de efectos y operaciones de factoring', 'gasto'),
  cuenta('668', 'Diferencias negativas de cambio', 'gasto'),
  cuenta('669', 'Otros gastos financieros', 'gasto'),
  subgrupo('67', 'Pérdidas procedentes de activos no corrientes y gastos excepcionales', 'gasto'),
  cuenta('678', 'Gastos excepcionales', 'gasto'),
  cuenta('682', 'Amortización de las inversiones inmobiliarias', 'gasto'),
  subgrupo('69', 'Pérdidas por deterioro y otras dotaciones', 'gasto'),
  cuenta('694', 'Pérdidas por deterioro de créditos por operaciones comerciales', 'gasto'),
  // Grupo 7
  cuenta('701', 'Ventas de productos terminados', 'ingreso'),
  cuenta('702', 'Ventas de productos semiterminados', 'ingreso'),
  cuenta('703', 'Ventas de subproductos y residuos', 'ingreso'),
  cuenta('704', 'Ventas de envases y embalajes', 'ingreso'),
  cuenta('706', 'Descuentos sobre ventas por pronto pago', 'ingreso'),
  cuenta('708', 'Devoluciones de ventas y operaciones similares', 'ingreso'),
  cuenta('709', 'Rappels sobre ventas', 'ingreso'),
  subgrupo('74', 'Subvenciones, donaciones y legados', 'ingreso'),
  cuenta('740', 'Subvenciones, donaciones y legados a la explotación', 'ingreso'),
  subgrupo('75', 'Otros ingresos de gestión', 'ingreso'),
  cuenta('752', 'Ingresos por arrendamientos', 'ingreso'),
  cuenta('759', 'Ingresos por servicios diversos', 'ingreso'),
  cuenta('762', 'Ingresos de créditos', 'ingreso'),
  // Cobros de facturas en divisa a un tipo mejor que el de la factura (la 668 es la perdida).
  cuenta('768', 'Diferencias positivas de cambio', 'ingreso'),
  subgrupo('77', 'Beneficios procedentes de activos no corrientes e ingresos excepcionales', 'ingreso'),
  cuenta('778', 'Ingresos excepcionales', 'ingreso'),
];

/**
 * Plan base completo, ordenado por codigo. El orden por codigo coincide con el
 * del arbol: 1, 10, 100, 101, 11, 110...
 */
export const PGC_BASE: PgcNode[] = [...PGC_NODOS, ...PGC_AMPLIACION].sort((a, b) => a.code.localeCompare(b.code));


// ==== Funciones helper ====

const isNumeric = (value: string): boolean => /^[0-9]+$/.test(value);

export function getGroupFromCode(code: string): string | null {
  if (!code || code.length < 1 || !isNumeric(code)) return null;
  return code[0];
}

export function getSubgroupFromCode(code: string): string | null {
  if (!code || code.length < 2 || !isNumeric(code)) return null;
  return code.substring(0, 2);
}

export function getAccountFromCode(code: string): string | null {
  if (!code || code.length < 3 || !isNumeric(code)) return null;
  return code.substring(0, 3);
}

export function findNode(pgc: PgcNode[], code: string): PgcNode | undefined {
  return pgc.find((n) => n.code === code);
}

export function existsCode(pgc: PgcNode[], code: string): boolean {
  return !!findNode(pgc, code);
}

// ==== Validaciones puras ====

/**
 * Puede crear un subgrupo si:
 * - El groupCode es válido (1-7)
 * - proposedSubgroupCode tiene longitud 2
 * - Es numérico
 * - Empieza por el mismo dígito de groupCode
 * - No existe ya una entrada con ese código
 */
export function canCreateSubgroup(
  pgc: PgcNode[],
  groupCode: string,
  proposedSubgroupCode: string,
): boolean {
  if (!groupCode || groupCode.length !== 1 || !isNumeric(groupCode)) return false;
  if (!proposedSubgroupCode || proposedSubgroupCode.length !== 2 || !isNumeric(proposedSubgroupCode)) {
    return false;
  }
  if (!proposedSubgroupCode.startsWith(groupCode)) return false;
  if (existsCode(pgc, proposedSubgroupCode)) return false;
  return true;
}

/**
 * Puede crear una subcuenta si:
 * - La accountCode existe y es de nivel 'account'
 * - proposedCode es numérico
 * - Empieza por accountCode
 * - Longitud > accountCode.length (típicamente 6+)
 * - No existe ya en el plan
 */
export function canCreateSubaccount(
  pgc: PgcNode[],
  accountCode: string,
  proposedCode: string,
): boolean {
  const account = findNode(pgc, accountCode);
  if (!account || account.level !== 'account') return false;
  if (!proposedCode || !isNumeric(proposedCode)) return false;
  if (!proposedCode.startsWith(accountCode)) return false;
  if (proposedCode.length <= accountCode.length) return false;
  if (existsCode(pgc, proposedCode)) return false;
  return true;
}

/**
 * Validación genérica de nuevo código (subgrupo, cuenta o subcuenta)
 * - code numérico
 * - type coherente con el grupo
 * - no colisiona con códigos PGC base (isSystem=true) si se pretende crear algo nuevo
 * - grupo prefijo correcto
 */
export function validateNewCode(
  pgc: PgcNode[],
  code: string,
  type: PgcType,
  expectedGroupCode?: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!code) {
    errors.push('El código no puede estar vacío.');
  } else if (!isNumeric(code)) {
    errors.push('El código debe ser numérico.');
  }

  const groupCode = getGroupFromCode(code);
  if (!groupCode) {
    errors.push('No se ha podido determinar el grupo del código.');
  }

  if (expectedGroupCode && groupCode && groupCode !== expectedGroupCode) {
    errors.push(`El código debe pertenecer al grupo ${expectedGroupCode}.`);
  }

  // Colisión con PGC base (isSystem = true)
  const existing = findNode(pgc, code);
  if (existing && existing.isSystem) {
    errors.push(`El código ${code} ya existe en el PGC base y no puede reutilizarse.`);
  }

  // Coherencia mínima tipo-grupo (regla simple, puedes afinarla)
  if (groupCode) {
    if (['1'].includes(groupCode) && type !== 'patrimonio_neto' && type !== 'pasivo') {
      errors.push('Los códigos del grupo 1 suelen ser patrimonio neto o pasivo.');
    }
    if (['2', '3', '4', '5'].includes(groupCode) && type !== 'activo' && type !== 'pasivo') {
      errors.push('Los códigos de los grupos 2-5 suelen ser activo o pasivo.');
    }
    if (groupCode === '6' && type !== 'gasto') {
      errors.push('Los códigos del grupo 6 deben ser de tipo gasto.');
    }
    if (groupCode === '7' && type !== 'ingreso') {
      errors.push('Los códigos del grupo 7 deben ser de tipo ingreso.');
    }
  }

  return { valid: errors.length === 0, errors };
}
