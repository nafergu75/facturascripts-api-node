/**
 * Ayudas de los tests con base de datos de «Traer la contabilidad de 2026»:
 * crear una empresa de prueba y traer una carga entera (analizar, confirmar e
 * importar todas las fases).
 */
import { prisma } from '../../../config/database';
import { aplicarFase, confirmarCarga, type ResultadoFase } from '../../../services/arranque/aplicar.service';
import { subirYAnalizar, type RespuestaCarga } from '../../../services/arranque/cargas.service';
import { datosEmpresaCompletos, type FicheroPrueba } from './generar';

export const USUARIO_PRUEBA = 'usuario-arranque';
export const TODOS = { cliente: true, proveedor: true };

/** Empresa española con los datos completos (o de otro pais). */
export async function empresaDePrueba(id: string, pais = 'ES') {
  await prisma.company.create({ data: { id, name: `Arranque ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { ...datosEmpresaCompletos(id), pais, ...(pais === 'ES' ? {} : { monedaCuenta: 'USD' }) } });
}

export async function aplicarTodo(companyId: string, cargaId: string): Promise<ResultadoFase[]> {
  const pasos: ResultadoFase[] = [];
  for (let i = 0; i < 60; i++) {
    const r = await aplicarFase(companyId, 2027, cargaId, USUARIO_PRUEBA);
    pasos.push(r);
    if (r.terminada) return pasos;
  }
  throw new Error('No termina');
}

/** Sube, analiza, confirma e importa. Falla si el analisis tiene errores. */
export async function traerCarga(companyId: string, ficheros: FicheroPrueba[], ajustes?: unknown): Promise<{ r: RespuestaCarga; pasos: ResultadoFase[] }> {
  const r = await subirYAnalizar(companyId, 2027, USUARIO_PRUEBA, ficheros.map((f) => ({ nombre: f.nombre, contenido: f.contenido })), ajustes, TODOS);
  if (!r.vista.puedeConfirmar) throw new Error(`La carga tiene errores: ${r.vista.comprobaciones.mensaje}`);
  await confirmarCarga(companyId, 2027, r.carga.id, r.vista.huella, USUARIO_PRUEBA);
  const pasos = await aplicarTodo(companyId, r.carga.id);
  return { r, pasos };
}
