/**
 * Seeding de demo. Crea una empresa + usuario admin + datos contables suficientes
 * para probar IVA, Modelo 200, cuentas anuales, reportes y conciliacion.
 *
 * Ejecucion:  ts-node scripts/seed-demo.ts
 *
 * NOTA: usa los services reales. Para que funcione necesita MySQL (Prisma) y un
 * FacturaScripts accesible. Varios pasos quedan como TODO/orientativos porque
 * dependen de datos maestros del FS destino (almacen/serie/cliente).
 */
import { crearEmpresa, crearUsuario, asignarUsuarioAEmpresa } from '../src/services/admin.service';

async function main(): Promise<void> {
  // 1) Empresa demo (instancia FacturaScripts local) + usuario admin
  const empresa = await crearEmpresa({
    nombre: 'Empresa Demo Seed',
    fsBaseUrl: process.env.FS_API_URL ?? 'http://localhost:8000/api/3',
    fsApiKey: process.env.FS_API_KEY ?? 'demo',
  });
  const usuario = await crearUsuario({ email: 'seed@empresa.com', password: 'demo1234' });
  await asignarUsuarioAEmpresa(usuario.id, empresa.id, 'admin');
  console.log(`Empresa ${empresa.id} + usuario ${usuario.email} (admin) creados.`);

  // 2) TODO: plan contable base ya viene de planContable.service (in-memory).
  //    Crear subcuentas tipicas: subcuentasService.crearSubcuentaEmpresa(...)

  // 3) TODO: crear clientes/productos en FacturaScripts via la API (clientes.service)
  //    y facturas (crearFacturaCliente) de varios trimestres e importes.

  // 4) TODO: contabilizar las facturas (asientos.service) para alimentar:
  //    - IVA 303/390, Modelo 200, cuentas anuales, reportes de margen.

  // 5) TODO: generar movimientos bancarios (bancos.service.importarMovimientosDesdeCSV)
  //    para probar la conciliacion contra los asientos de tesoreria.

  console.log('Seed base completado. Pasos 2-5 marcados como TODO (dependen del FS destino).');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  });
