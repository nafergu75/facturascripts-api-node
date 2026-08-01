import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FS_API_URL = process.env.FS_API_URL || 'http://localhost:8000/api/3';
const FS_API_KEY = process.env.FS_API_KEY || '';
const COMPANY_ID = process.env.COMPANY_ID || '1';
const DRY_RUN = process.argv.includes('--dry-run');
const CONTINUE_ON_ERROR = process.argv.includes('--continue-on-error');

interface MigrationResult {
  total: number;
  ok: number;
  errors: Array<{ registro: string; error: string }>;
}

const fsClient = axios.create({
  baseURL: FS_API_URL,
  headers: { Token: FS_API_KEY },
});

interface FSCliente {
  codcliente: string;
  nombre: string;
  cifnif: string;
  email?: string;
  telefono1?: string;
  activo?: boolean;
}

interface FSProveedor {
  codproveedor: string;
  nombre: string;
  cifnif: string;
  email?: string;
  telefono1?: string;
  activo?: boolean;
}

interface FSProducto {
  referencia: string;
  nombre: string;
  precio: number;
  stockfis?: number;
  bloqueado?: boolean;
}

async function migrateClientes(): Promise<MigrationResult> {
  console.log('📥 Clientes: leyendo FS...');
  const result: MigrationResult = { total: 0, ok: 0, errors: [] };

  try {
    const res = await fsClient.get('/clientes?limit=500');
    const clientes = res.data.items as FSCliente[];
    console.log(`  ${clientes.length} clientes encontrados en FS`);
    result.total = clientes.length;

    for (const c of clientes) {
      try {
        if (DRY_RUN) {
          console.log(`  DRY: Customer ${c.codcliente} ${c.nombre}`);
          result.ok++;
        } else {
          await prisma.customer.upsert({
            where: { companyId_nifCif: { companyId: COMPANY_ID, nifCif: c.cifnif } },
            update: { telefono: c.telefono1 || undefined },
            create: {
              companyId: COMPANY_ID,
              nombreFiscal: c.nombre,
              nifCif: c.cifnif,
              email: c.email,
              telefono: c.telefono1 || undefined,
              activo: c.activo !== false,
            },
          });
          result.ok++;
        }
      } catch (e: any) {
        const msg = e.message || String(e);
        console.error(`  ❌ ${c.cifnif} ${c.nombre}: ${msg}`);
        result.errors.push({ registro: `${c.cifnif}`, error: msg });
        if (!CONTINUE_ON_ERROR) throw e;
      }
    }
    console.log(`✅ Clientes: ${result.ok}/${result.total} migrados${result.errors.length ? ` (${result.errors.length} errores)` : ''}`);
  } catch (e: any) {
    console.error(`❌ Clientes abortado: ${e.message}`);
  }

  return result;
}

async function migrateProveedores(): Promise<MigrationResult> {
  console.log('📥 Proveedores: leyendo FS...');
  const result: MigrationResult = { total: 0, ok: 0, errors: [] };

  try {
    const res = await fsClient.get('/proveedores?limit=500');
    const proveedores = res.data.items as FSProveedor[];
    console.log(`  ${proveedores.length} proveedores encontrados en FS`);
    result.total = proveedores.length;

    for (const p of proveedores) {
      try {
        if (DRY_RUN) {
          console.log(`  DRY: Supplier ${p.codproveedor} ${p.nombre}`);
          result.ok++;
        } else {
          await prisma.supplier.upsert({
            where: { companyId_nifCif: { companyId: COMPANY_ID, nifCif: p.cifnif } },
            update: { telefono: p.telefono1 || undefined },
            create: {
              companyId: COMPANY_ID,
              nombreFiscal: p.nombre,
              nifCif: p.cifnif,
              email: p.email,
              telefono: p.telefono1 || undefined,
              activo: p.activo !== false,
            },
          });
          result.ok++;
        }
      } catch (e: any) {
        const msg = e.message || String(e);
        console.error(`  ❌ ${p.cifnif} ${p.nombre}: ${msg}`);
        result.errors.push({ registro: `${p.cifnif}`, error: msg });
        if (!CONTINUE_ON_ERROR) throw e;
      }
    }
    console.log(`✅ Proveedores: ${result.ok}/${result.total} migrados${result.errors.length ? ` (${result.errors.length} errores)` : ''}`);
  } catch (e: any) {
    console.error(`❌ Proveedores abortado: ${e.message}`);
  }

  return result;
}

async function migrateProductos(): Promise<MigrationResult> {
  console.log('📥 Productos: leyendo FS...');
  const result: MigrationResult = { total: 0, ok: 0, errors: [] };

  try {
    const res = await fsClient.get('/productos?limit=500');
    const productos = res.data.items as FSProducto[];
    console.log(`  ${productos.length} productos encontrados en FS`);
    result.total = productos.length;

    for (const p of productos) {
      try {
        if (DRY_RUN) {
          console.log(`  DRY: Product ${p.referencia} ${p.nombre}`);
          result.ok++;
        } else {
          await prisma.product.upsert({
            where: { companyId_referencia: { companyId: COMPANY_ID, referencia: p.referencia } },
            update: { precio: p.precio, stock: p.stockfis || 0, bloqueado: p.bloqueado === true },
            create: {
              companyId: COMPANY_ID,
              referencia: p.referencia,
              descripcion: p.nombre,
              precio: p.precio || 0,
              stock: p.stockfis || 0,
              bloqueado: p.bloqueado === true,
            },
          });
          result.ok++;
        }
      } catch (e: any) {
        const msg = e.message || String(e);
        console.error(`  ❌ ${p.referencia} ${p.nombre}: ${msg}`);
        result.errors.push({ registro: `${p.referencia}`, error: msg });
        if (!CONTINUE_ON_ERROR) throw e;
      }
    }
    console.log(`✅ Productos: ${result.ok}/${result.total} migrados${result.errors.length ? ` (${result.errors.length} errores)` : ''}`);
  } catch (e: any) {
    console.error(`❌ Productos abortado: ${e.message}`);
  }

  return result;
}

async function main() {
  if (!FS_API_KEY) {
    console.error('❌ FS_API_KEY no configurada');
    process.exit(1);
  }

  if (DRY_RUN) console.log('🔍 MODO DRY-RUN (sin escribir)\n');
  if (CONTINUE_ON_ERROR) console.log('⚙️  --continue-on-error: saltando registros con error\n');

  const results = {
    clientes: await migrateClientes(),
    proveedores: await migrateProveedores(),
    productos: await migrateProductos(),
  };

  await prisma.$disconnect();

  // Resumen
  console.log('\n═══════════════════════════════════════');
  const totalOk = results.clientes.ok + results.proveedores.ok + results.productos.ok;
  const totalRecs = results.clientes.total + results.proveedores.total + results.productos.total;
  const allErrors = [...results.clientes.errors, ...results.proveedores.errors, ...results.productos.errors];

  if (allErrors.length === 0) {
    console.log(`✨ MIGRACION OK: ${totalOk}/${totalRecs} registros migrados`);
    process.exit(0);
  } else {
    console.log(`⚠️  MIGRACION PARCIAL: ${totalOk}/${totalRecs} OK, ${allErrors.length} errores:`);
    allErrors.forEach((e) => console.log(`   - ${e.registro}: ${e.error}`));
    console.log('\nOpciones:');
    console.log('  1. Revisar BD: npx prisma studio');
    console.log('  2. Re-ejecutar: npm run migrate:fs:dry (sin aplicar cambios)');
    console.log('  3. Continuar: npm run migrate:fs -- --continue-on-error');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n❌ Migracion fallida:', e.message);
  process.exit(1);
});
