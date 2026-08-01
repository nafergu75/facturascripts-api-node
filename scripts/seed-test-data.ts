import { prisma } from '../src/config/database';

async function seedTestData() {
  console.log('🌱 Seeding test data...');

  try {
    // 1. Crear o conseguir una empresa
    let company = await prisma.company.findFirst({
      where: { name: 'Test Company' },
    });

    if (!company) {
      company = await prisma.company.create({
        data: {
          name: 'Test Company',
          fsBaseUrl: 'http://localhost:8080',
          fsApiKeyEnc: 'test-dummy-key',
        },
      });
      console.log('✅ Created company:', company.name);
    } else {
      console.log('✅ Using existing company:', company.name);
    }

    // 2. Crear movimientos de prueba (últimos 12 meses)
    const movements = [
      // Junio 2026
      { type: 'income', amount: 5000, category: 'Ventas', description: 'Venta a cliente Acme Corp', date: '2026-06-30' },
      { type: 'income', amount: 3000, category: 'Servicios', description: 'Consultoría sistema TI', date: '2026-06-28' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 6', date: '2026-06-25' },
      { type: 'expense', amount: 200, category: 'Electricidad', description: 'Factura electricidad', date: '2026-06-20' },
      { type: 'income', amount: 2500, category: 'Asesoramiento', description: 'Asesoría legal empresa', date: '2026-06-18' },
      { type: 'expense', amount: 150, category: 'Teléfono', description: 'Factura telefonía móvil', date: '2026-06-15' },
      { type: 'income', amount: 4000, category: 'Ventas', description: 'Venta a cliente BigCorp', date: '2026-06-10' },
      { type: 'expense', amount: 800, category: 'Salarios', description: 'Nómina empleado 1', date: '2026-06-05' },
      { type: 'income', amount: 1500, category: 'Servicios', description: 'Mantenimiento software', date: '2026-06-01' },

      // Mayo 2026
      { type: 'income', amount: 4500, category: 'Ventas', description: 'Venta a cliente GlobalTech', date: '2026-05-30' },
      { type: 'expense', amount: 300, category: 'Suministros', description: 'Papelería y tóner', date: '2026-05-28' },
      { type: 'income', amount: 2000, category: 'Servicios', description: 'Formación personalizada', date: '2026-05-25' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 5', date: '2026-05-20' },
      { type: 'expense', amount: 180, category: 'Electricidad', description: 'Factura electricidad', date: '2026-05-15' },
      { type: 'income', amount: 3500, category: 'Asesoramiento', description: 'Consultoría empresarial', date: '2026-05-10' },

      // Abril 2026
      { type: 'income', amount: 6000, category: 'Ventas', description: 'Venta a cliente Premium', date: '2026-04-30' },
      { type: 'expense', amount: 1000, category: 'Salarios', description: 'Nómina empleado 1', date: '2026-04-27' },
      { type: 'income', amount: 2500, category: 'Servicios', description: 'Mantenimiento web', date: '2026-04-25' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 4', date: '2026-04-20' },
      { type: 'expense', amount: 250, category: 'Suministros', description: 'Equipamiento de oficina', date: '2026-04-15' },

      // Marzo 2026
      { type: 'income', amount: 3800, category: 'Ventas', description: 'Venta a cliente StartUp', date: '2026-03-30' },
      { type: 'expense', amount: 200, category: 'Electricidad', description: 'Factura electricidad', date: '2026-03-25' },
      { type: 'income', amount: 1800, category: 'Asesoramiento', description: 'Consultoría de procesos', date: '2026-03-20' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 3', date: '2026-03-15' },

      // Febrero 2026
      { type: 'income', amount: 4200, category: 'Ventas', description: 'Venta a cliente TechSol', date: '2026-02-28' },
      { type: 'expense', amount: 800, category: 'Salarios', description: 'Nómina empleado 1', date: '2026-02-25' },
      { type: 'income', amount: 2200, category: 'Servicios', description: 'Soporte técnico', date: '2026-02-20' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 2', date: '2026-02-15' },

      // Enero 2026
      { type: 'income', amount: 5500, category: 'Ventas', description: 'Venta a cliente NuevoBiz', date: '2026-01-30' },
      { type: 'expense', amount: 150, category: 'Teléfono', description: 'Factura telefonía', date: '2026-01-25' },
      { type: 'income', amount: 2800, category: 'Asesoramiento', description: 'Asesoría anual', date: '2026-01-20' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 1', date: '2026-01-15' },
      { type: 'expense', amount: 200, category: 'Electricidad', description: 'Factura electricidad', date: '2026-01-10' },

      // Diciembre 2025
      { type: 'income', amount: 7000, category: 'Ventas', description: 'Venta fin de año', date: '2025-12-31' },
      { type: 'income', amount: 3000, category: 'Servicios', description: 'Bonificación cliente', date: '2025-12-28' },
      { type: 'expense', amount: 1200, category: 'Salarios', description: 'Nómina + bonificación', date: '2025-12-25' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 12', date: '2025-12-20' },

      // Noviembre 2025
      { type: 'income', amount: 4800, category: 'Ventas', description: 'Venta cliente importante', date: '2025-11-30' },
      { type: 'expense', amount: 300, category: 'Suministros', description: 'Material consumible', date: '2025-11-25' },
      { type: 'income', amount: 2100, category: 'Servicios', description: 'Consultoría mensual', date: '2025-11-20' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 11', date: '2025-11-15' },

      // Octubre 2025
      { type: 'income', amount: 5200, category: 'Ventas', description: 'Venta de productos', date: '2025-10-30' },
      { type: 'expense', amount: 800, category: 'Salarios', description: 'Nómina empleado', date: '2025-10-25' },
      { type: 'income', amount: 1900, category: 'Asesoramiento', description: 'Asesoría fiscal', date: '2025-10-20' },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina mes 10', date: '2025-10-15' },
    ];

    // Insertar movimientos (evitar duplicados por fecha + categoría)
    for (const mov of movements) {
      const existing = await prisma.movement.findFirst({
        where: {
          companyId: company.id,
          type: mov.type as any,
          amount: mov.amount,
          date: new Date(mov.date),
        },
      });

      if (!existing) {
        await prisma.movement.create({
          data: {
            companyId: company.id,
            type: mov.type as 'income' | 'expense',
            amount: mov.amount,
            category: mov.category,
            description: mov.description,
            date: new Date(mov.date),
            fiscalYear: parseInt(mov.date.split('-')[0]),
            status: 'approved',
          },
        });
      }
    }

    console.log(`✅ Created/verified ${movements.length} movements`);

    // 3. Mostrar resumen
    const stats = await prisma.movement.aggregate({
      where: { companyId: company.id },
      _sum: {
        amount: true,
      },
      _count: true,
    });

    console.log('\n📊 Summary:');
    console.log(`  Company: ${company.name} (ID: ${company.id})`);
    console.log(`  Total movements: ${stats._count}`);
    console.log(`  Total income: €${stats._sum.amount}`);

    console.log('\n✨ Test data seeded successfully!');
    console.log(`\nUse companyId: ${company.id} in your requests`);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seedTestData();
