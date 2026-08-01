import { badRequest, notFound } from '../utils/http-errors';
import { prisma } from '../config/database';

/**
 * Estructura del PGC español (Plan General de Contabilidad).
 * Basada en la versión actualizada (2021).
 */
const PGC_BASE_STRUCTURE = {
  grupos: [
    {
      codigo: '1',
      nombre: 'FINANCIACIÓN BÁSICA',
      nivel: 1,
      naturaleza: 'PASIVO',
      tipoUso: 'BALANCE',
      subgrupos: [
        {
          codigo: '10',
          nombre: 'Capital',
          nivel: 2,
          cuentas: [
            { codigo: '100', nombre: 'Capital social', nivel: 3, naturaleza: 'PATRIMONIO_NETO' },
            { codigo: '101', nombre: 'Fondo social', nivel: 3, naturaleza: 'PATRIMONIO_NETO' },
          ],
        },
        {
          codigo: '11',
          nombre: 'Reservas',
          nivel: 2,
          cuentas: [
            { codigo: '110', nombre: 'Reserva legal', nivel: 3, naturaleza: 'PATRIMONIO_NETO' },
            { codigo: '113', nombre: 'Reservas voluntarias', nivel: 3, naturaleza: 'PATRIMONIO_NETO' },
          ],
        },
      ],
    },
    {
      codigo: '2',
      nombre: 'INMOVILIZADO',
      nivel: 1,
      naturaleza: 'ACTIVO',
      tipoUso: 'BALANCE',
      subgrupos: [
        {
          codigo: '20',
          nombre: 'Inmovilizaciones inmateriales',
          nivel: 2,
          cuentas: [
            { codigo: '200', nombre: 'Investigación', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '202', nombre: 'Concesiones administrativas', nivel: 3, naturaleza: 'ACTIVO' },
          ],
        },
        {
          codigo: '21',
          nombre: 'Inmovilizaciones materiales',
          nivel: 2,
          cuentas: [
            { codigo: '210', nombre: 'Terrenos y construcciones', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '211', nombre: 'Instalaciones técnicas', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '216', nombre: 'Mobiliario', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '217', nombre: 'Equipos para proceso de información', nivel: 3, naturaleza: 'ACTIVO' },
          ],
        },
      ],
    },
    {
      codigo: '3',
      nombre: 'EXISTENCIAS',
      nivel: 1,
      naturaleza: 'ACTIVO',
      tipoUso: 'BALANCE',
      subgrupos: [
        {
          codigo: '30',
          nombre: 'Mercaderías',
          nivel: 2,
          cuentas: [
            { codigo: '300', nombre: 'Mercaderías A', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '301', nombre: 'Mercaderías B', nivel: 3, naturaleza: 'ACTIVO' },
          ],
        },
        {
          codigo: '31',
          nombre: 'Materias primas',
          nivel: 2,
          cuentas: [
            { codigo: '310', nombre: 'Materias primas', nivel: 3, naturaleza: 'ACTIVO' },
          ],
        },
      ],
    },
    {
      codigo: '4',
      nombre: 'ACREEDORES Y DEUDORES POR OPERACIONES COMERCIALES',
      nivel: 1,
      naturaleza: 'ACTIVO',
      tipoUso: 'BALANCE',
      subgrupos: [
        {
          codigo: '43',
          nombre: 'Clientes',
          nivel: 2,
          cuentas: [
            { codigo: '430', nombre: 'Clientes', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '4300', nombre: 'Clientes nacionales (4 dígitos)', nivel: 4, naturaleza: 'ACTIVO' },
          ],
        },
        {
          codigo: '40',
          nombre: 'Proveedores',
          nivel: 2,
          cuentas: [
            { codigo: '400', nombre: 'Proveedores', nivel: 3, naturaleza: 'PASIVO' },
            { codigo: '4000', nombre: 'Proveedores nacionales (4 dígitos)', nivel: 4, naturaleza: 'PASIVO' },
          ],
        },
        {
          codigo: '47',
          nombre: 'Administración Pública',
          nivel: 2,
          cuentas: [
            { codigo: '472', nombre: 'Hacienda Pública, IVA soportado', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '4751', nombre: 'Hacienda Pública, acreedora por retenciones practicadas', nivel: 3, naturaleza: 'PASIVO' },
            { codigo: '477', nombre: 'Hacienda Pública, IVA repercutido', nivel: 3, naturaleza: 'PASIVO' },
          ],
        },
      ],
    },
    {
      codigo: '5',
      nombre: 'CUENTAS FINANCIERAS',
      nivel: 1,
      naturaleza: 'ACTIVO',
      tipoUso: 'BALANCE',
      subgrupos: [
        {
          codigo: '57',
          nombre: 'Tesorería',
          nivel: 2,
          cuentas: [
            { codigo: '570', nombre: 'Caja', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '572', nombre: 'Bancos e instituciones de crédito', nivel: 3, naturaleza: 'ACTIVO' },
            { codigo: '5720', nombre: 'Cuentas corrientes', nivel: 4, naturaleza: 'ACTIVO' },
            { codigo: '5721', nombre: 'Cuentas de ahorro', nivel: 4, naturaleza: 'ACTIVO' },
          ],
        },
      ],
    },
    {
      codigo: '6',
      nombre: 'COMPRAS Y GASTOS',
      nivel: 1,
      naturaleza: 'GASTO',
      tipoUso: 'PYG',
      subgrupos: [
        {
          codigo: '60',
          nombre: 'Compras',
          nivel: 2,
          cuentas: [
            { codigo: '600', nombre: 'Compra de mercaderías', nivel: 3, naturaleza: 'GASTO' },
            { codigo: '601', nombre: 'Compra de materias primas', nivel: 3, naturaleza: 'GASTO' },
          ],
        },
        {
          codigo: '62',
          nombre: 'Servicios exteriores',
          nivel: 2,
          cuentas: [
            { codigo: '620', nombre: 'Gastos de transporte', nivel: 3, naturaleza: 'GASTO' },
            { codigo: '621', nombre: 'Gastos de reparación y conservación', nivel: 3, naturaleza: 'GASTO' },
            { codigo: '622', nombre: 'Gastos de arrendamiento', nivel: 3, naturaleza: 'GASTO' },
            { codigo: '623', nombre: 'Reparación y conservación', nivel: 3, naturaleza: 'GASTO' },
          ],
        },
      ],
    },
    {
      codigo: '7',
      nombre: 'VENTAS E INGRESOS',
      nivel: 1,
      naturaleza: 'INGRESO',
      tipoUso: 'PYG',
      subgrupos: [
        {
          codigo: '70',
          nombre: 'Ventas de mercaderías',
          nivel: 2,
          cuentas: [
            { codigo: '700', nombre: 'Ventas de mercaderías', nivel: 3, naturaleza: 'INGRESO' },
            { codigo: '7000', nombre: 'Ventas de mercaderías A', nivel: 4, naturaleza: 'INGRESO' },
            { codigo: '7001', nombre: 'Ventas de mercaderías B', nivel: 4, naturaleza: 'INGRESO' },
          ],
        },
        {
          codigo: '75',
          nombre: 'Otros ingresos de explotación',
          nivel: 2,
          cuentas: [
            { codigo: '750', nombre: 'Ingresos por servicios diversos', nivel: 3, naturaleza: 'INGRESO' },
          ],
        },
      ],
    },
  ],
};

export interface CrearCuentaDTO {
  companyId: string;
  codigo: string;
  nombre: string;
  parentCodigo: string;
  naturaleza: string;
  tipoUso: string;
  notas?: string;
}

/**
 * Inicializar el plan contable para una empresa.
 * Clon el PGC base a la empresa.
 */
export async function inicializarPlanContableEmpresa(
  companyId: string,
  versionPGC: string = '2021',
  gruposAIncluir: number[] = [1, 2, 3, 4, 5, 6, 7],
): Promise<void> {
  // Verificar que la empresa existe
  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
  });
  if (!empresa) throw badRequest('Empresa no encontrada.');

  // Verificar si ya hay cuentas para esta empresa
  const yaTiene = await prisma.chartOfAccounts.findFirst({
    where: { companyId, esBasePGC: true },
  });
  if (yaTiene) throw badRequest('La empresa ya tiene un plan contable inicializado.');

  // Crear cuentas base del PGC para la empresa
  const cuentasACrear: any[] = [];

  for (const grupo of PGC_BASE_STRUCTURE.grupos) {
    if (!gruposAIncluir.includes(Number(grupo.codigo))) continue;

    // Crear la cuenta de grupo (nivel 1)
    const cuentaGrupo = {
      companyId,
      codigo: grupo.codigo,
      nombre: grupo.nombre,
      grupo: Number(grupo.codigo),
      nivel: grupo.nivel,
      naturaleza: grupo.naturaleza,
      tipoUso: grupo.tipoUso,
      esBasePGC: true,
      esPersonalizadaEmpresa: false,
      versionPGC,
      parentId: null,
      parentCodigo: null,
    };
    cuentasACrear.push(cuentaGrupo);

    // Crear subgrupos y cuentas
    for (const subgrupo of grupo.subgrupos || []) {
      // Subgrupo (nivel 2)
      const cuentaSubgrupo = {
        companyId,
        codigo: subgrupo.codigo,
        nombre: subgrupo.nombre,
        grupo: Number(grupo.codigo),
        nivel: subgrupo.nivel,
        naturaleza: grupo.naturaleza,
        tipoUso: grupo.tipoUso,
        esBasePGC: true,
        esPersonalizadaEmpresa: false,
        versionPGC,
        parentCodigo: grupo.codigo,
      };
      cuentasACrear.push(cuentaSubgrupo);

      // Cuentas (nivel 3+)
      for (const cuenta of subgrupo.cuentas || []) {
        const cuentaData = {
          companyId,
          codigo: cuenta.codigo,
          nombre: cuenta.nombre,
          grupo: Number(grupo.codigo),
          nivel: cuenta.nivel,
          naturaleza: cuenta.naturaleza || grupo.naturaleza,
          tipoUso: grupo.tipoUso,
          esBasePGC: true,
          esPersonalizadaEmpresa: false,
          versionPGC,
          parentCodigo: subgrupo.codigo,
        };
        cuentasACrear.push(cuentaData);
      }
    }
  }

  // Crear todas las cuentas en BD
  for (const cuenta of cuentasACrear) {
    await prisma.chartOfAccounts.create({ data: cuenta });
  }
}

/**
 * Listar plan contable con filtros.
 */
export async function listarPlanContable(
  companyId: string,
  filtros?: {
    grupo?: number;
    nivel?: number;
    naturaleza?: string;
    soloActivas?: boolean;
  },
) {
  const where: any = { companyId };

  if (filtros?.grupo) where.grupo = filtros.grupo;
  if (filtros?.nivel) where.nivel = filtros.nivel;
  if (filtros?.naturaleza) where.naturaleza = filtros.naturaleza;
  if (filtros?.soloActivas) where.activo = true;

  const cuentas = await prisma.chartOfAccounts.findMany({
    where,
    include: { children: true },
    orderBy: [{ grupo: 'asc' }, { codigo: 'asc' }],
  });

  return cuentas;
}

/**
 * Obtener una cuenta por código.
 */
export async function obtenerCuentaPorCodigo(
  companyId: string,
  codigo: string,
) {
  const cuenta = await prisma.chartOfAccounts.findFirst({
    where: { companyId, codigo },
    include: { children: true },
  });

  if (!cuenta) throw notFound(`Cuenta ${codigo} no encontrada.`);
  return cuenta;
}

/**
 * Crear subcuenta personalizada.
 */
export async function crearSubcuentaPersonalizada(
  dto: CrearCuentaDTO,
) {
  // Validar que el padre existe
  const padre = await prisma.chartOfAccounts.findFirst({
    where: { companyId: dto.companyId, codigo: dto.parentCodigo },
  });
  if (!padre) throw badRequest(`Cuenta padre ${dto.parentCodigo} no encontrada.`);

  // Validar que no existe ya
  const existe = await prisma.chartOfAccounts.findFirst({
    where: { companyId: dto.companyId, codigo: dto.codigo },
  });
  if (existe) throw badRequest(`Cuenta ${dto.codigo} ya existe.`);

  // Determinar nivel (padre.nivel + 1)
  const nivel = padre.nivel + 1;

  const nueva = await prisma.chartOfAccounts.create({
    data: {
      companyId: dto.companyId,
      codigo: dto.codigo,
      nombre: dto.nombre,
      grupo: padre.grupo,
      nivel,
      naturaleza: dto.naturaleza || padre.naturaleza,
      tipoUso: dto.tipoUso || padre.tipoUso,
      esBasePGC: false,
      esPersonalizadaEmpresa: true,
      parentId: padre.id,
      parentCodigo: padre.codigo,
      notas: dto.notas,
    },
  });

  return nueva;
}

/**
 * Actualizar cuenta (solo personalizadas).
 */
export async function actualizarCuenta(
  id: string,
  companyId: string,
  datos: { nombre?: string; activo?: boolean; notas?: string },
) {
  const cuenta = await prisma.chartOfAccounts.findFirst({
    where: { id, companyId },
  });

  if (!cuenta) throw notFound('Cuenta no encontrada.');
  if (cuenta.esBasePGC && datos.nombre) {
    throw badRequest('No se puede editar el nombre de cuentas del PGC base.');
  }

  const actualizada = await prisma.chartOfAccounts.update({
    where: { id },
    data: datos,
  });

  return actualizada;
}

/**
 * Obtener estructura jerárquica completa (árbol).
 */
export async function obtenerArbolPlanContable(
  companyId: string,
  grupoFilro?: number,
) {
  const grupos = await prisma.chartOfAccounts.findMany({
    where: {
      companyId,
      nivel: 1,
      ...(grupoFilro && { grupo: grupoFilro }),
    },
    include: {
      children: {
        include: {
          children: {
            include: {
              children: true,
            },
          },
        },
      },
    },
    orderBy: { codigo: 'asc' },
  });

  return grupos;
}

export const chartOfAccountsService = {
  inicializarPlanContableEmpresa,
  listarPlanContable,
  obtenerCuentaPorCodigo,
  crearSubcuentaPersonalizada,
  actualizarCuenta,
  obtenerArbolPlanContable,
};
