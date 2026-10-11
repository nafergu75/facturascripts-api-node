/**
 * Pasa lo ya contabilizado en las cuentas genericas 430, 400 y 410 a la
 * subcuenta propia de cada cliente y proveedor (services/terceros/migracion.ts).
 *
 * No lo ejecutes a mano contra produccion: usa el envoltorio, que lee la BD
 * de ENV_PROD y pide confirmacion antes de aplicar:
 *   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/migrar-subcuentas-terceros.sh --todas
 *
 * Opciones:
 *   --empresa <id>       una empresa (se puede repetir)
 *   --todas              todas las empresas
 *   --aplicar            escribe los cambios (sin esto, SOLO SIMULA)
 *   --incluir-cerrados   sigue aunque la empresa tenga ejercicios cerrados
 *                        (reabrelos antes y vuelve a cerrarlos despues)
 *   --longitud <N>       longitud de las subcuentas (7 a 10) para las empresas
 *                        que aun no tienen ninguna; sin ella, esas empresas se
 *                        paran (si van a traer su plan de 2026, eso antes)
 */
import { prisma } from '../src/config/database';
import { EjerciciosCerradosError, informeEnTexto, LongitudSinFijarError, migrarSubcuentasTerceros } from '../src/services/terceros/migracion';

function uso(): void {
  console.log('Uso: migrar-subcuentas-terceros.ts (--empresa <id> ... | --todas) [--aplicar] [--incluir-cerrados] [--longitud <7-10>]');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const empresas: string[] = [];
  let todas = false;
  let aplicar = false;
  let incluirCerrados = false;
  let longitud: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--empresa' && args[i + 1]) empresas.push(args[++i]);
    else if (a === '--todas') todas = true;
    else if (a === '--aplicar') aplicar = true;
    else if (a === '--incluir-cerrados') incluirCerrados = true;
    else if (a === '--longitud' && args[i + 1]) {
      longitud = Number(args[++i]);
      if (!Number.isInteger(longitud) || longitud < 7 || longitud > 10) {
        console.log('--longitud tiene que ser un número de 7 a 10.');
        return 2;
      }
    }
    else if (a === '-h' || a === '--help') {
      uso();
      return 0;
    } else {
      console.log(`Opción desconocida: ${a}`);
      uso();
      return 2;
    }
  }
  if (todas) empresas.push(...(await prisma.company.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })).map((c) => c.id));
  if (!empresas.length) {
    uso();
    return 2;
  }

  let errores = 0;
  for (const id of [...new Set(empresas)]) {
    try {
      const informe = await migrarSubcuentasTerceros(id, { aplicar, incluirCerrados, longitud });
      console.log(informeEnTexto(informe));
    } catch (e) {
      errores++;
      if (e instanceof EjerciciosCerradosError || e instanceof LongitudSinFijarError) console.log(`Empresa ${id}: ${e.message}`);
      else console.log(`Empresa ${id}: ERROR ${(e as Error).message}`);
    }
    console.log('');
  }
  if (!aplicar) console.log('SIMULACIÓN: no se ha escrito nada. Para aplicarlo, repite con --aplicar.');
  return errores ? 1 : 0;
}

main()
  .then(async (codigo) => {
    await prisma.$disconnect();
    process.exit(codigo);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
