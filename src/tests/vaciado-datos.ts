/**
 * Datos de prueba para el vaciado de produccion: varias empresas con ventas,
 * rectificativas, cobros, gastos y pagos, nominas, lecturas con su fichero,
 * carga de 2026, usuarios que no son administradores, Carmen, AuditLog,
 * VERI*FACTU en pruebas (una factura emitida con su registro encadenado, que
 * la app no deja borrar, y la bitacora), las imagenes de la plantilla B... y
 * al final una fila en cada tabla que siga vacia, para que ninguna tabla del
 * esquema se quede sin probar.
 *
 * Usa los servicios de la app (como los tests de cada parte) y la base de
 * DATABASE_URL. Solo para src/tests/vaciado-produccion.db.test.ts.
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { marcarEmpresaPruebas } from './ayuda-empresa-pruebas';
import { hashPassword } from '../utils/password';
import { crearEmpresa, crearUsuario } from '../services/admin.service';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { expenseInvoicesService, type CrearFacturaGastoDTO } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { crearEmpleado } from '../services/empleados.service';
import { contabilizarNominas, crearNomina } from '../services/nominas.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { letraNif } from '../utils/nif';
import { ordenDeRestauracion, clasificarTablas } from '../services/vaciadoProduccion/tablas';

/** Lo que hace de PFX y contraseña cifrados del certificado de VERI*FACTU (no van en la copia local). */
export const SECRETO_PFX_PRUEBA = 'v1:pfx-cifrado-de-prueba-que-no-va-en-la-copia';
export const SECRETO_PASS_PRUEBA = 'v1:contrasena-cifrada-de-prueba-que-no-va-en-la-copia';

export interface DatosVaciado {
  adminId: string;
  adminEmail: string;
  adminClave: string;
  empresas: string[];
  /** Claves de los ficheros escritos en el almacen de pruebas. */
  ficheros: string[];
  /** Fichero que no es de la app: no se tiene que borrar. */
  ficheroAjeno: string;
}

const motor = new AccountingEngineController();
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const linea = (precio: number) => ({ descripcion: 'Servicio de prueba', cantidad: 1, precioUnitario: precio, tipoIva: 21 });

async function guardar(almacen: string, clave: string, contenido: string): Promise<string> {
  const ruta = path.join(almacen, ...clave.split('/'));
  await fsp.mkdir(path.dirname(ruta), { recursive: true });
  await fsp.writeFile(ruta, contenido);
  return `storage/${clave}`;
}

/** Ventas, rectificativa, cobros, gastos, pagos, nominas, lecturas y carga de 2026 de una empresa. */
async function datosDeEmpresa(companyId: string, n: number, almacen: string, ficheros: string[]): Promise<void> {
  await prisma.ajustesFiscales.upsert({ where: { companyId }, update: { inicioEnApp: '2026-01-01' }, create: { companyId, inicioEnApp: '2026-01-01' } });
  await asegurarPlanContableEmpresa(companyId);
  const cliente = await prisma.customer.create({ data: { companyId, nombreFiscal: `Cliente ${n} SL`, nifCif: `B5${String(n).padStart(7, '0')}` } });
  const proveedor = await prisma.supplier.create({ data: { companyId, nombreFiscal: `Proveedor ${n} SL`, nifCif: `B6${String(n).padStart(7, '0')}` } });
  await prisma.supplierContact.create({ data: { supplierId: proveedor.id, nombre: 'Contacto' } });
  await prisma.supplierAudit.create({ data: { supplierId: proveedor.id, tipoAccion: 'create' } });
  const banco = await prisma.bankAccount.create({ data: { companyId, iban: `ES00000000000000000000${n}0`, subcuentaCodigo: `572000${n}` } });

  // Ventas: dos facturas, una contabilizada y cobrada en parte, y una rectificativa.
  const venta = (base: number) =>
    incomeInvoicesService.crearIngreso({ companyId, customer: { id: cliente.id }, fechaEmision: '2026-09-01', fechaVencimiento: '2099-12-31', lineas: [linea(base)] } as CrearFacturaIngresoDTO);
  const f1 = await venta(1000);
  await venta(250);
  const r1 = await motor.contabilizarFacturaIngreso(companyId, f1.id);
  await prisma.journalEntry.update({ where: { id: r1.journalEntryId }, data: { estado: 'POSTED' } });
  await registrarCobroFactura(companyId, 'INGRESO', f1.id, { fecha: '2026-09-10', importe: 500, cuentaBancariaId: banco.id });
  await incomeInvoicesService.crearIngreso({
    companyId,
    customer: {},
    lineas: [linea(-100)],
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelve parte del pedido', originales: [{ id: f1.id }] },
  } as unknown as CrearFacturaIngresoDTO);

  // Gastos: uno contabilizado y pagado.
  const g = await expenseInvoicesService.crearGasto({
    companyId,
    provider: { id: proveedor.id },
    serie: 'P',
    fechaEmision: '2026-09-02',
    fechaVencimiento: '2026-10-02',
    lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 400, tipoIva: 21 }],
  } as CrearFacturaGastoDTO);
  const rg = await motor.contabilizarFacturaGasto(companyId, g.id);
  await prisma.journalEntry.update({ where: { id: rg.journalEntryId }, data: { estado: 'POSTED' } });
  await registrarCobroFactura(companyId, 'GASTO', g.id, { fecha: '2026-09-15', cuentaBancariaId: banco.id });

  // Nominas: un trabajador con su nomina contabilizada.
  const e = await crearEmpleado(companyId, { nif: nif(30000000 + n), nombre: 'Persona', apellidos: `Prueba ${n}`, fechaAlta: '2026-01-01' });
  await crearNomina(companyId, { empleadoId: e.id, ejercicio: 2026, mes: 1, brutoDinerario: 1000, ssTrabajador: 63.5, irpf: 100, liquido: 836.5, ssEmpresa: 300 });
  await contabilizarNominas(companyId, 2026, 1);

  // Lectura con su fichero, y la factura archivada.
  const lecturaId = randomUUID();
  const claveLectura = `lecturas/${companyId}/${lecturaId}-factura.pdf`;
  await prisma.lecturaDocumento.create({
    data: {
      id: lecturaId,
      companyId,
      lector: 'GASTO',
      estado: 'LISTA',
      archivoNombre: 'factura.pdf',
      archivoTipo: 'application/pdf',
      archivoTamanio: 9,
      archivoHash: createHash('sha256').update(lecturaId).digest('hex'),
      archivoRef: await guardar(almacen, claveLectura, '%PDF-1.4\n'),
    },
  });
  const claveArchivo = `archivo/${companyId}/2026/3T/ventas/2026-09-01_A-1_cliente.pdf`;
  await prisma.documentoArchivo.create({
    data: {
      companyId,
      tipo: 'ingreso',
      fecha: '2026-09-01',
      mes: 9,
      trimestre: 3,
      anio: 2026,
      archivoNombre: 'A-1.pdf',
      archivoTipo: 'application/pdf',
      archivoTamanio: 12,
      archivoPath: await guardar(almacen, claveArchivo, 'pdf de venta'),
      archivoHash: 'h',
      incomeInvoiceId: f1.id,
    },
  });

  // Carga de 2026: el fichero de la gestoria, una partida pendiente y un activo con su dotacion.
  const cargaId = randomUUID();
  const sha = createHash('sha256').update(cargaId).digest('hex');
  const claveCarga = `arranque/${companyId}/${cargaId}/${sha}`;
  await guardar(almacen, claveCarga, 'libro diario de la gestoria');
  await prisma.cargaArranque.create({
    data: {
      id: cargaId,
      companyId,
      ejercicio: 2027,
      version: 1,
      tipo: 'PROVISIONAL',
      estado: 'BORRADOR',
      ficheros: [{ nombre: 'diario.xlsx', sha256: sha, tamano: 27, clave: claveCarga }],
      createdBy: 'prueba',
    },
  });
  await prisma.partidaPendiente.create({
    data: { companyId, cargaId, tipo: 'COBRO', subcuenta: '43000001', customerId: cliente.id, numeroDocumento: `F-2026-${n}`, importePendiente: 121 },
  });
  const activo = await prisma.activoFijo.create({
    data: {
      companyId,
      cargaId,
      descripcion: 'Ordenador',
      subcuentaBien: '2170000',
      subcuentaAmortAcum: '2817000',
      subcuentaDotacion: '6817000',
      fechaAlta: '2026-01-01',
      fechaInicioAmortizacion: '2026-01-01',
      coste: 1200,
      coeficiente: 25,
    },
  });
  await prisma.dotacionAmortizacion.create({ data: { companyId, activoFijoId: activo.id, periodo: '2027-01', importe: 25, journalEntryId: rg.journalEntryId } });

  // Carmen, declaraciones y VERI*FACTU (sin activar).
  const sesion = await prisma.chatSession.create({ data: { companyId, userId: 'u', titulo: 'Hola' } });
  await prisma.chatMessage.create({ data: { sessionId: sesion.id, companyId, userId: 'u', role: 'user', content: 'Hola' } });
  await prisma.carmenLlamadaIA.create({ data: { companyId, userId: 'u', modelo: 'claude-haiku-4-5', estado: 'ok' } });
  await prisma.carmenContador.create({ data: { clave: `empresa:${companyId}:2026-10-14`, mensajes: 3 } });
  await prisma.declaracionAeat.create({ data: { companyId, codigo: '303', ejercicio: 2026, periodo: '3T', secuencia: 1, tipo: 'N', estado: 'presentada', justificante: '3030000000001' } });
  await prisma.verifactuConfig.create({ data: { companyId, motivoExclusion: null } });
  await prisma.auditLog.create({ data: { userId: 'u', companyId, action: 'PRUEBA', resourceType: 'EMPRESA', resourceId: companyId } });

  // Mas ficheros de la app: una subida a medias y una factura archivada en JSON (sin empresa en la ruta).
  ficheros.push(claveLectura, claveArchivo, claveCarga);
  const subida = `puesta-en-marcha/subidas/${companyId}/${randomUUID()}/meta.json`;
  await guardar(almacen, subida, '{}');
  ficheros.push(subida);
}

/**
 * Crea las empresas y sus datos. `almacen` es la carpeta storage/ de pruebas
 * (la que despues lee el script con VACIADO_ALMACEN_DISCO).
 */
export async function crearDatosVaciado(almacen: string): Promise<DatosVaciado> {
  const adminEmail = 'admin.global@vaciado.test';
  const adminClave = `Clave-${randomUUID()}`;
  const admin = await prisma.user.create({ data: { email: adminEmail, passwordHash: hashPassword(adminClave), isGlobalAdmin: true, nombre: 'Administrador' } });

  // La empresa 1 y demo@empresa.com vienen del seed (prisma/seed.ts).
  const empresas = ['1'];
  await prisma.membership.create({ data: { userId: admin.id, companyId: '1', role: 'admin' } });
  await prisma.legalConfig.upsert({
    where: { companyId: '1' },
    update: {},
    create: { companyId: '1', denominacion: 'IFBIOSOLUCIONES SA', nif: 'A10952364', logo: Buffer.from('logo-png'), logoMime: 'image/png' },
  });
  const otra = await crearEmpresa({ nombre: 'NEWZELAND PRUEBAS', codigo: 'NZP' }, admin.id);
  empresas.push(otra.id);
  await prisma.legalConfig.create({ data: { companyId: otra.id, denominacion: 'NEWZELAND CENTER SL', nif: 'B98765432' } });
  const tercera = await crearEmpresa({ nombre: 'Empresa vacía de prueba' }, admin.id);
  empresas.push(tercera.id);

  const ficheros: string[] = [];
  await datosDeEmpresa('1', 1, almacen, ficheros);
  await datosDeEmpresa(otra.id, 2, almacen, ficheros);

  // Usuarios que no son administradores globales.
  const contable = await crearUsuario({ email: 'contable@vaciado.test', password: 'Contable-1234-abcd', companyId: otra.id, rol: 'contable' });
  await crearUsuario({ email: 'ventas@vaciado.test', password: 'Ventas-1234-abcd', companyId: '1', rol: 'ventas' });

  // Sesiones cerradas, contadores de Carmen y auditoria de la plataforma.
  const manana = new Date(Date.now() + 86_400_000);
  await prisma.revokedToken.create({ data: { jti: randomUUID(), userId: admin.id, expiresAt: manana } });
  await prisma.revokedToken.create({ data: { jti: randomUUID(), userId: contable.id, expiresAt: manana } });
  await prisma.carmenContador.create({ data: { clave: 'global:2026-10', costeUsd: new Prisma.Decimal('0.25') } });
  await prisma.carmenContador.create({ data: { clave: `usuario:${admin.id}:2026-10-14`, mensajes: 2 } });
  await prisma.carmenContador.create({ data: { clave: `usuario:${contable.id}:2026-10-14`, mensajes: 1 } });
  await prisma.ajustePlataforma.create({ data: { clave: 'verifactu.redSeguridad', valor: { activa: true }, cambiadoPor: admin.id } });
  await prisma.auditLog.create({ data: { userId: admin.id, companyId: null, action: 'RED_SEGURIDAD_CAMBIADA', resourceType: 'AJUSTE_PLATAFORMA', resourceId: 'verifactu.redSeguridad' } });
  await prisma.auditLog.create({ data: { userId: admin.id, companyId: null, action: 'USUARIO_CREADO', resourceType: 'USUARIO', resourceId: contable.id } });
  await prisma.tipoCambioBce.create({ data: { moneda: 'USD', fecha: '2026-10-13', unidadesPorEur: new Prisma.Decimal('1.149') } });
  await prisma.chartOfAccounts.create({ data: { companyId: null, codigo: '700', nombre: 'Ventas de mercaderías (plan base)', grupo: 7, nivel: 3, naturaleza: 'INGRESO', tipoUso: 'PYG' } });

  // VERI*FACTU en PRUEBAS en la empresa 1: la factura emitida lleva su registro
  // encadenado y la cabeza de su cadena (inalterables para la app: el script los
  // borra con SQL). Bitacora: lo de una empresa y lo de un usuario que se borra
  // se va; lo de la plataforma sin usuario o del administrador se queda.
  await prisma.verifactuConfig.upsert({ where: { companyId: '1' }, update: { estado: 'PRUEBAS', entorno: 'PRUEBAS' }, create: { companyId: '1', estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
  // Desde la fase F2, PRUEBAS solo en una empresa de pruebas (si no, la emision da 409).
  await marcarEmpresaPruebas(prisma, '1');
  const clienteVf = await prisma.customer.create({ data: { companyId: '1', nombreFiscal: 'Cliente VERI*FACTU SL', nifCif: 'B12345674', pais: 'ES' } });
  await incomeInvoicesService.crearIngreso({ companyId: '1', customer: { id: clienteVf.id }, fechaEmision: '2026-09-15', lineas: [linea(250)] } as CrearFacturaIngresoDTO);
  await prisma.verifactuBitacora.create({ data: { companyId: '1', tipo: 'REGISTRO_GENERADO', usuarioId: admin.id, detalle: { prueba: true } } });
  await prisma.verifactuBitacora.create({ data: { companyId: null, tipo: 'RED_SEGURIDAD', usuarioId: admin.id, detalle: { activa: true } } });
  await prisma.verifactuBitacora.create({ data: { companyId: null, tipo: 'SISTEMA', usuarioId: null, detalle: {} } });
  await prisma.verifactuBitacora.create({ data: { companyId: null, tipo: 'PRUEBA_USUARIO', usuarioId: contable.id, detalle: {} } });
  // Logo de la marca de la plantilla B (dentro de la base, como el logo de la empresa).
  await prisma.imagenFactura.create({ data: { companyId: otra.id, tipo: 'MARCA', datos: Buffer.from('marca-png'), mime: 'image/png' } });
  // Certificado de VERI*FACTU con unos «secretos» reconocibles: la copia local no los tiene que llevar.
  await prisma.verifactuCertificado.create({
    data: {
      companyId: '1',
      pfxEnc: SECRETO_PFX_PRUEBA,
      passEnc: SECRETO_PASS_PRUEBA,
      titular: 'IFBIOSOLUCIONES SA',
      nifTitular: 'A10952364',
      emisor: 'AC DE PRUEBAS',
      numeroSerie: '4A1B2C',
      validoDesde: new Date('2026-01-01T00:00:00Z'),
      caducaEn: new Date('2027-12-31T00:00:00Z'),
      huellaSha256: 'A'.repeat(64),
      subidoPor: admin.id,
    },
  });

  // Ficheros sin empresa en la ruta y uno que no es de la app.
  const json = 'facturas/ingresos/2026-09/A-1.json';
  await guardar(almacen, json, '{"numero":"A-1"}');
  ficheros.push(json);
  const ficheroAjeno = 'otra-app/no-tocar.txt';
  await guardar(almacen, ficheroAjeno, 'esto no es de la app');

  await rellenarTablasVacias(empresas[0]);
  return { adminId: admin.id, adminEmail, adminClave, empresas, ficheros, ficheroAjeno };
}

/**
 * Una fila minima en cada tabla que siga vacia (de la empresa indicada), en el
 * orden de las claves ajenas: asi el vaciado se prueba con TODAS las tablas.
 */
async function rellenarTablasVacias(companyId: string): Promise<void> {
  const db = new PrismaClient();
  try {
    const modelos = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
    for (const nombre of ordenDeRestauracion(clasificarTablas().tablas)) {
      const m = modelos.get(nombre)!;
      const delegado = (db as unknown as Record<string, { count(): Promise<number>; create(a: unknown): Promise<unknown>; findFirst(): Promise<Record<string, unknown> | null> }>)[
        nombre.charAt(0).toLowerCase() + nombre.slice(1)
      ];
      if ((await delegado.count()) > 0) continue;
      const claves = new Map<string, unknown>();
      for (const f of m.fields) {
        if (f.kind !== 'object' || !f.relationFromFields?.length || !f.isRequired) continue;
        const padre = await (db as unknown as Record<string, { findFirst(): Promise<Record<string, unknown> | null> }>)[f.type.charAt(0).toLowerCase() + f.type.slice(1)].findFirst();
        if (!padre) throw new Error(`No hay fila en ${f.type} para rellenar ${nombre}.`);
        f.relationFromFields.forEach((c, i) => claves.set(c, padre[f.relationToFields![i]]));
      }
      const data: Record<string, unknown> = {};
      for (const f of m.fields) {
        if (f.kind === 'object' || f.isUpdatedAt) continue;
        if (claves.has(f.name)) data[f.name] = claves.get(f.name);
        else if (f.name === 'companyId') data[f.name] = companyId;
        else if (!f.isRequired || f.hasDefaultValue) continue;
        else data[f.name] = valorMinimo(f.type as string, f.kind);
      }
      await delegado.create({ data });
    }
  } finally {
    await db.$disconnect();
  }
}

function valorMinimo(tipo: string, kind: string): unknown {
  if (kind === 'enum') return 'admin';
  switch (tipo) {
    case 'Int':
    case 'Float':
      return 1;
    case 'Decimal':
      return new Prisma.Decimal(1);
    case 'Boolean':
      return false;
    case 'DateTime':
      return new Date();
    case 'Json':
      return {};
    case 'Bytes':
      return Buffer.from('x');
    case 'BigInt':
      return BigInt(1);
    default:
      return 'x'; // cabe en cualquier VARCHAR(1)
  }
}
