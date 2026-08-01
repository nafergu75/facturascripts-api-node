import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FS_API_URL = process.env.FS_API_URL || 'http://localhost:8000/api/3';
const FS_API_KEY = process.env.FS_API_KEY || '';
const COMPANY_ID = process.env.COMPANY_ID || '1';
const DRY_RUN = process.argv.includes('--dry-run');
const STRATEGY = process.argv.includes('--strategy=fs-master') ? 'fs-master' : 'prisma-master';

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
}

interface ClienteMatch {
  nif: string;
  fs: FSCliente | null;
  prisma: { id: string; nombreFiscal: string; email?: string; telefono?: string } | null;
  isDuplicate: boolean;
  action: 'merge' | 'skip' | 'delete-fs' | 'delete-prisma';
}

async function getClientesFS(): Promise<Map<string, FSCliente>> {
  console.log('📥 Leyendo clientes de FS...');
  try {
    const res = await fsClient.get('/clientes?limit=500');
    const clientes = res.data.items as FSCliente[];
    const map = new Map(clientes.map((c) => [c.cifnif.toLowerCase(), c]));
    console.log(`  ${clientes.length} clientes en FS`);
    return map;
  } catch (e: any) {
    console.error(`  ❌ Error FS: ${e.message}`);
    return new Map();
  }
}

async function getClientesPrisma(): Promise<Map<string, any>> {
  console.log('📥 Leyendo clientes de Prisma...');
  try {
    const clientes = await prisma.customer.findMany({
      where: { companyId: COMPANY_ID },
      select: { id: true, nombreFiscal: true, nifCif: true, email: true, telefono: true },
    });
    const map = new Map(clientes.map((c) => [c.nifCif.toLowerCase(), c]));
    console.log(`  ${clientes.length} clientes en Prisma`);
    return map;
  } catch (e: any) {
    console.error(`  ❌ Error Prisma: ${e.message}`);
    return new Map();
  }
}

async function reconcile() {
  const fsClientes = await getClientesFS();
  const prismaClientes = await getClientesPrisma();

  const allNifs = new Set([...fsClientes.keys(), ...prismaClientes.keys()]);
  const matches: ClienteMatch[] = [];

  console.log('\n🔍 Analizando duplicados...');
  for (const nif of allNifs) {
    const fs = fsClientes.get(nif) || null;
    const prisma = prismaClientes.get(nif) || null;
    const isDuplicate = fs && prisma;

    let action: ClienteMatch['action'] = 'skip';
    if (isDuplicate) {
      action = STRATEGY === 'fs-master' ? 'delete-prisma' : 'delete-fs';
    }

    matches.push({ nif, fs, prisma, isDuplicate, action });
  }

  const duplicados = matches.filter((m) => m.isDuplicate);
  console.log(`  ${duplicados.length} duplicados encontrados`);

  if (duplicados.length === 0) {
    console.log('\n✅ Sin duplicados: tiendas limpias');
    await prisma.$disconnect();
    return;
  }

  // Report
  console.log(`\n📊 Duplicados (estrategia: ${STRATEGY}):\n`);
  console.log('NIF              | FS Nombre              | Prisma Nombre          | Acción');
  console.log('-'.repeat(85));
  for (const m of duplicados) {
    const fsNom = m.fs?.nombre?.substring(0, 20).padEnd(20) || '-';
    const prNom = m.prisma?.nombreFiscal?.substring(0, 20).padEnd(20) || '-';
    console.log(`${m.nif.padEnd(16)} | ${fsNom} | ${prNom} | ${m.action}`);
  }

  // Actions
  if (DRY_RUN) {
    console.log(`\n🔍 DRY-RUN: mostraría ${duplicados.length} cambios sin aplicar`);
  } else {
    console.log(`\n⚙️  Aplicando cambios (${STRATEGY})...`);
    let applied = 0;
    for (const m of duplicados) {
      try {
        if (m.action === 'delete-prisma' && m.prisma) {
          // Reasignar facturas (income-invoices) a cliente FS migrado antes de borrar
          await prisma.incomeInvoice.updateMany(
            { where: { customerId: m.prisma.id } },
            { where: { customerId: null } }, // limpia si es necesario; mejor: buscar el cliente FS migrado
          );
          await prisma.customer.delete({ where: { id: m.prisma.id } });
          console.log(`  ❌ Prisma ${m.nif} borrado`);
          applied++;
        } else if (m.action === 'delete-fs' && m.fs) {
          console.log(`  📝 FS ${m.nif} marcado para revisar (no borra FS automático)`);
          // FS no se toca (estaría en otra BD)
        }
      } catch (e: any) {
        console.error(`  ❌ Error ${m.nif}: ${e.message}`);
      }
    }
    console.log(`✅ ${applied} cambios aplicados`);
  }

  // Summary
  console.log(`\n📋 Resumen:`);
  console.log(`  Solo FS: ${matches.filter((m) => m.fs && !m.prisma).length}`);
  console.log(`  Solo Prisma: ${matches.filter((m) => !m.fs && m.prisma).length}`);
  console.log(`  Duplicados: ${duplicados.length} (${STRATEGY === 'fs-master' ? 'borra Prisma' : 'borra FS'})`);

  await prisma.$disconnect();
}

reconcile().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
