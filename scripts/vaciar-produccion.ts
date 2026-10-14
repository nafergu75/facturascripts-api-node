/**
 * Vaciado de produccion («todo a cero»). No lo lances a mano: usa el
 * envoltorio, que lee la base de ENV_PROD sin ensenarla y pide confirmacion:
 *   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --ayuda
 * La logica esta en src/services/vaciadoProduccion/.
 */
import { main } from '../src/services/vaciadoProduccion/cli';

main(process.argv.slice(2))
  .then((codigo) => process.exit(codigo))
  .catch((e) => {
    // Sin el detalle: podria llevar la URL de la base. main ya tapa sus errores.
    console.log(`ERROR inesperado: ${e instanceof Error ? e.name : 'error'}`);
    process.exit(1);
  });
