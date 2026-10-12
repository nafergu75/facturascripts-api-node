import { prisma } from '../src/config/database';
import { fechaHaceMeses } from '../src/utils/fechas';

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

    // 2. Movimientos de prueba de los nueve meses anteriores al actual. Las fechas
    // van relativas a hoy (hora de Madrid), así que el script sirve cualquier año.
    const movements = [
      // Hace 1 mes
      { type: 'income', amount: 5000, category: 'Ventas', description: 'Venta a cliente Acme Corp', date: fechaHaceMeses(1, 30) },
      { type: 'income', amount: 3000, category: 'Servicios', description: 'Consultoría sistema TI', date: fechaHaceMeses(1, 28) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(1, 25) },
      { type: 'expense', amount: 200, category: 'Electricidad', description: 'Factura electricidad', date: fechaHaceMeses(1, 20) },
      { type: 'income', amount: 2500, category: 'Asesoramiento', description: 'Asesoría legal empresa', date: fechaHaceMeses(1, 18) },
      { type: 'expense', amount: 150, category: 'Teléfono', description: 'Factura telefonía móvil', date: fechaHaceMeses(1, 15) },
      { type: 'income', amount: 4000, category: 'Ventas', description: 'Venta a cliente BigCorp', date: fechaHaceMeses(1, 10) },
      { type: 'expense', amount: 800, category: 'Salarios', description: 'Nómina empleado 1', date: fechaHaceMeses(1, 5) },
      { type: 'income', amount: 1500, category: 'Servicios', description: 'Mantenimiento software', date: fechaHaceMeses(1, 1) },

      // Hace 2 meses
      { type: 'income', amount: 4500, category: 'Ventas', description: 'Venta a cliente GlobalTech', date: fechaHaceMeses(2, 30) },
      { type: 'expense', amount: 300, category: 'Suministros', description: 'Papelería y tóner', date: fechaHaceMeses(2, 28) },
      { type: 'income', amount: 2000, category: 'Servicios', description: 'Formación personalizada', date: fechaHaceMeses(2, 25) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(2, 20) },
      { type: 'expense', amount: 180, category: 'Electricidad', description: 'Factura electricidad', date: fechaHaceMeses(2, 15) },
      { type: 'income', amount: 3500, category: 'Asesoramiento', description: 'Consultoría empresarial', date: fechaHaceMeses(2, 10) },

      // Hace 3 meses
      { type: 'income', amount: 6000, category: 'Ventas', description: 'Venta a cliente Premium', date: fechaHaceMeses(3, 30) },
      { type: 'expense', amount: 1000, category: 'Salarios', description: 'Nómina empleado 1', date: fechaHaceMeses(3, 27) },
      { type: 'income', amount: 2500, category: 'Servicios', description: 'Mantenimiento web', date: fechaHaceMeses(3, 25) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(3, 20) },
      { type: 'expense', amount: 250, category: 'Suministros', description: 'Equipamiento de oficina', date: fechaHaceMeses(3, 15) },

      // Hace 4 meses
      { type: 'income', amount: 3800, category: 'Ventas', description: 'Venta a cliente StartUp', date: fechaHaceMeses(4, 30) },
      { type: 'expense', amount: 200, category: 'Electricidad', description: 'Factura electricidad', date: fechaHaceMeses(4, 25) },
      { type: 'income', amount: 1800, category: 'Asesoramiento', description: 'Consultoría de procesos', date: fechaHaceMeses(4, 20) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(4, 15) },

      // Hace 5 meses
      { type: 'income', amount: 4200, category: 'Ventas', description: 'Venta a cliente TechSol', date: fechaHaceMeses(5, 28) },
      { type: 'expense', amount: 800, category: 'Salarios', description: 'Nómina empleado 1', date: fechaHaceMeses(5, 25) },
      { type: 'income', amount: 2200, category: 'Servicios', description: 'Soporte técnico', date: fechaHaceMeses(5, 20) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(5, 15) },

      // Hace 6 meses
      { type: 'income', amount: 5500, category: 'Ventas', description: 'Venta a cliente NuevoBiz', date: fechaHaceMeses(6, 30) },
      { type: 'expense', amount: 150, category: 'Teléfono', description: 'Factura telefonía', date: fechaHaceMeses(6, 25) },
      { type: 'income', amount: 2800, category: 'Asesoramiento', description: 'Asesoría anual', date: fechaHaceMeses(6, 20) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(6, 15) },
      { type: 'expense', amount: 200, category: 'Electricidad', description: 'Factura electricidad', date: fechaHaceMeses(6, 10) },

      // Hace 7 meses
      { type: 'income', amount: 7000, category: 'Ventas', description: 'Venta fin de año', date: fechaHaceMeses(7, 31) },
      { type: 'income', amount: 3000, category: 'Servicios', description: 'Bonificación cliente', date: fechaHaceMeses(7, 28) },
      { type: 'expense', amount: 1200, category: 'Salarios', description: 'Nómina + bonificación', date: fechaHaceMeses(7, 25) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(7, 20) },

      // Hace 8 meses
      { type: 'income', amount: 4800, category: 'Ventas', description: 'Venta cliente importante', date: fechaHaceMeses(8, 30) },
      { type: 'expense', amount: 300, category: 'Suministros', description: 'Material consumible', date: fechaHaceMeses(8, 25) },
      { type: 'income', amount: 2100, category: 'Servicios', description: 'Consultoría mensual', date: fechaHaceMeses(8, 20) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(8, 15) },

      // Hace 9 meses
      { type: 'income', amount: 5200, category: 'Ventas', description: 'Venta de productos', date: fechaHaceMeses(9, 30) },
      { type: 'expense', amount: 800, category: 'Salarios', description: 'Nómina empleado', date: fechaHaceMeses(9, 25) },
      { type: 'income', amount: 1900, category: 'Asesoramiento', description: 'Asesoría fiscal', date: fechaHaceMeses(9, 20) },
      { type: 'expense', amount: 500, category: 'Alquiler', description: 'Alquiler oficina', date: fechaHaceMeses(9, 15) },
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
