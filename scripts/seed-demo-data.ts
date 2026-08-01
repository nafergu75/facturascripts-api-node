/**
 * Script de Demostración - Crea datos de prueba para Motor Contable
 *
 * Crea:
 * - 1 empresa de prueba
 * - 2 clientes
 * - 2 proveedores
 * - 3 facturas de ingreso con diferentes IVAs
 * - 2 facturas de compra con IRPF
 * - Asientos contables automáticos
 */

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

interface DemoData {
  companyId: string;
  customers: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  invoices: { id: string; number: string; total: number }[];
}

async function seedDemoData(): Promise<DemoData> {
  console.log('🌱 Creando datos de demostración...\n');

  // 1. Obtener empresa (creada por prisma/seed.ts)
  console.log('📱 1. Obteniendo empresa...');
  const company = await prisma.company.findFirst({
    where: { name: 'Empresa Demo' }
  });

  if (!company) {
    throw new Error('No se encontró la empresa "Empresa Demo". Ejecuta "npm run db:seed" primero.');
  }

  // Limpiar datos de demo anteriores
  console.log('🧹 Limpiando datos anteriores...');
  await prisma.incomeInvoice.deleteMany({ where: { companyId: company.id } });
  await prisma.expenseInvoice.deleteMany({ where: { companyId: company.id } });
  console.log('   ✅ Datos anteriores limpiados\n');

  console.log(`   ✅ Empresa obtenida: ${company.name}\n`);

  // 2. Crear clientes
  console.log('👥 2. Creando clientes...');
  const customers = [];

  const customer1 = await prisma.customer.create({
    data: {
      id: 'demo-cliente-acme',
      companyId: company.id,
      nombreFiscal: 'Acme S.L.',
      nifCif: '12345678A',
    },
  }).catch(async (err) => {
    if (err.code === 'P2002') {
      return prisma.customer.findUnique({ where: { id: 'demo-cliente-acme' } });
    }
    throw err;
  });

  const customer2 = await prisma.customer.create({
    data: {
      id: 'demo-cliente-tech',
      companyId: company.id,
      nombreFiscal: 'Tech Solutions Inc.',
      nifCif: '87654321B',
    },
  }).catch(async (err) => {
    if (err.code === 'P2002') {
      return prisma.customer.findUnique({ where: { id: 'demo-cliente-tech' } });
    }
    throw err;
  });

  if (customer1 && customer2) {
    customers.push(
      { id: customer1.id, name: customer1.nombreFiscal },
      { id: customer2.id, name: customer2.nombreFiscal }
    );
  }

  console.log(`   ✅ Clientes creados:`);
  customers.forEach((c) => console.log(`      • ${c.name}`));
  console.log();

  // 3. Crear proveedores
  console.log('🏭 3. Creando proveedores...');
  const suppliers = [];

  const supplier1 = await prisma.supplier.create({
    data: {
      id: 'demo-proveedor-distribuidor',
      companyId: company.id,
      nombreFiscal: 'Distribuidor XYZ S.A.',
      nifCif: 'B98765432',
    },
  }).catch(async (err) => {
    if (err.code === 'P2002') {
      return prisma.supplier.findUnique({ where: { id: 'demo-proveedor-distribuidor' } });
    }
    throw err;
  });

  const supplier2 = await prisma.supplier.create({
    data: {
      id: 'demo-proveedor-servicios',
      companyId: company.id,
      nombreFiscal: 'Servicios Profesionales Ltd.',
      nifCif: 'A12345678',
    },
  }).catch(async (err) => {
    if (err.code === 'P2002') {
      return prisma.supplier.findUnique({ where: { id: 'demo-proveedor-servicios' } });
    }
    throw err;
  });

  if (supplier1 && supplier2) {
    suppliers.push(
      { id: supplier1.id, name: supplier1.nombreFiscal },
      { id: supplier2.id, name: supplier2.nombreFiscal }
    );
  }

  console.log(`   ✅ Proveedores creados:`);
  suppliers.forEach((s) => console.log(`      • ${s.name}`));
  console.log();

  // 4. Crear facturas de ingreso
  console.log('💰 4. Creando facturas de ingreso...');
  const invoices = [];

  if (!customer1 || !customer2 || !supplier1 || !supplier2) {
    throw new Error('No se pudieron crear clientes/proveedores');
  }

  const invoice1 = await prisma.incomeInvoice.create({
    data: {
      id: randomUUID(),
      companyId: company.id,
      customerId: customer1.id,
      numero: 1,
      numeroCompleto: 'FAC-2026-DEMO-001',
      serie: 'FAC',
      fechaEmision: new Date('2026-07-15').toISOString().split('T')[0],
      fechaVencimiento: new Date('2026-08-15').toISOString().split('T')[0],
      estado: 'DRAFT',
      baseTotal: 1000,
      ivaTotal: 210,
      retencionTotal: 0,
      totalFactura: 1210,
    },
  });

  const invoice2 = await prisma.incomeInvoice.create({
    data: {
      id: randomUUID(),
      companyId: company.id,
      customerId: customer2.id,
      numero: 2,
      numeroCompleto: 'FAC-2026-DEMO-002',
      serie: 'FAC',
      fechaEmision: new Date('2026-07-18').toISOString().split('T')[0],
      fechaVencimiento: new Date('2026-08-18').toISOString().split('T')[0],
      estado: 'DRAFT',
      baseTotal: 2500,
      ivaTotal: 525,
      retencionTotal: 0,
      totalFactura: 3025,
    },
  });

  const invoice3 = await prisma.incomeInvoice.create({
    data: {
      id: randomUUID(),
      companyId: company.id,
      customerId: customer1.id,
      numero: 3,
      numeroCompleto: 'FAC-2026-DEMO-003',
      serie: 'FAC',
      fechaEmision: new Date('2026-07-20').toISOString().split('T')[0],
      fechaVencimiento: new Date('2026-09-20').toISOString().split('T')[0],
      estado: 'DRAFT',
      baseTotal: 500,
      ivaTotal: 50,
      retencionTotal: 0,
      totalFactura: 550,
    },
  });

  invoices.push(
    { id: invoice1.id, number: invoice1.numeroCompleto, total: invoice1.totalFactura },
    { id: invoice2.id, number: invoice2.numeroCompleto, total: invoice2.totalFactura },
    { id: invoice3.id, number: invoice3.numeroCompleto, total: invoice3.totalFactura }
  );

  console.log(`   ✅ Facturas de ingreso creadas:`);
  invoices.forEach((inv) => console.log(`      • ${inv.number} - €${inv.total.toFixed(2)}`));
  console.log();

  // 5. Crear facturas de compra
  console.log('📦 5. Creando facturas de compra...');

  const expense1 = await prisma.expenseInvoice.create({
    data: {
      id: randomUUID(),
      companyId: company.id,
      supplierId: supplier1.id,
      numero: 1,
      numeroCompleto: 'PROV-2026-DEMO-001',
      serie: 'PROV',
      fechaEmision: new Date('2026-07-10').toISOString().split('T')[0],
      fechaVencimiento: new Date('2026-08-10').toISOString().split('T')[0],
      estado: 'DRAFT',
      baseTotal: 500,
      ivaTotal: 105,
      retencionTotal: 0,
      totalFactura: 605,
    },
  });

  const expense2 = await prisma.expenseInvoice.create({
    data: {
      id: randomUUID(),
      companyId: company.id,
      supplierId: supplier2.id,
      numero: 2,
      numeroCompleto: 'PROV-2026-DEMO-002',
      serie: 'PROV',
      fechaEmision: new Date('2026-07-12').toISOString().split('T')[0],
      fechaVencimiento: new Date('2026-08-12').toISOString().split('T')[0],
      estado: 'DRAFT',
      baseTotal: 1200,
      ivaTotal: 252,
      retencionTotal: 180, // 15% IRPF
      totalFactura: 1272,
    },
  });

  console.log(`   ✅ Facturas de compra creadas:`);
  console.log(`      • PROV-2026-001 - €${expense1.totalFactura.toFixed(2)} (Materiales)`);
  console.log(`      • PROV-2026-002 - €${expense2.totalFactura.toFixed(2)} (Servicios con IRPF)`);
  console.log();

  return {
    companyId: company.id,
    customers: customers,
    suppliers: suppliers,
    invoices: invoices,
  };
}

async function main() {
  try {
    const data = await seedDemoData();

    console.log('\n' + '='.repeat(60));
    console.log('✨ DATOS DE DEMOSTRACIÓN CREADOS EXITOSAMENTE');
    console.log('='.repeat(60));
    console.log(`
📊 RESUMEN:
  • Empresa: Demo Empresa S.L.
  • Clientes: ${data.customers.length}
  • Proveedores: ${data.suppliers.length}
  • Facturas de ingreso: ${data.invoices.length}
  • Facturas de compra: 2

💡 PRÓXIMOS PASOS:
  1. Ve a http://localhost:3020/dashboard/facturas
  2. Verás las 3 facturas de ingreso creadas
  3. Contabiliza una factura para ver el asiento automático
  4. Ve a http://localhost:3020/dashboard/motor-contable
  5. Verás los asientos contables generados automáticamente

📝 ASIENTO ESPERADO (Factura FAC-2026-001):
  DEBE:  430000 (Clientes Acme S.L.)     1.210€
  HABER: 700000 (Ventas)                1.000€
  HABER: 477000 (IVA Repercutido 21%)     210€
         Total:                         1.210€

🔍 NOTA: Los asientos se crean en estado BORRADOR y requieren
   aprobación manual antes de afectar los balances.
    `);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
