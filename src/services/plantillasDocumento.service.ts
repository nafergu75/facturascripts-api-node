import { randomUUID } from 'crypto';
import { PlantillaDocumento, TipoDocumento } from '../domain/plantillas-documento.model';

/**
 * TODO: reemplazar este almacen en memoria por un repositorio Prisma
 * (plantillasRepository). De momento permite gestionar y probar la logica.
 */
const store = new Map<string, PlantillaDocumento>(); // id -> plantilla

const ahora = (): string => new Date().toISOString();

async function desmarcarPredeterminadas(companyId: string, tipo: TipoDocumento): Promise<void> {
  for (const p of store.values()) {
    if (p.companyId === companyId && p.tipoDocumento === tipo && p.predeterminada) {
      p.predeterminada = false;
      p.actualizadoEn = ahora();
    }
  }
}

export async function crearPlantilla(
  companyId: string,
  data: Omit<PlantillaDocumento, 'id' | 'companyId' | 'creadoEn' | 'actualizadoEn'>,
): Promise<PlantillaDocumento> {
  if (data.predeterminada) await desmarcarPredeterminadas(companyId, data.tipoDocumento);
  const plantilla: PlantillaDocumento = { ...data, id: randomUUID(), companyId, creadoEn: ahora(), actualizadoEn: ahora() };
  store.set(plantilla.id, plantilla);
  return plantilla;
}

export async function obtenerPlantilla(companyId: string, plantillaId: string): Promise<PlantillaDocumento | null> {
  const p = store.get(plantillaId);
  return p && p.companyId === companyId ? p : null;
}

export async function actualizarPlantilla(
  companyId: string,
  plantillaId: string,
  data: Partial<Omit<PlantillaDocumento, 'id' | 'companyId' | 'creadoEn'>>,
): Promise<PlantillaDocumento | null> {
  const actual = await obtenerPlantilla(companyId, plantillaId);
  if (!actual) return null;
  if (data.predeterminada) await desmarcarPredeterminadas(companyId, data.tipoDocumento ?? actual.tipoDocumento);
  const actualizada: PlantillaDocumento = { ...actual, ...data, id: actual.id, companyId, creadoEn: actual.creadoEn, actualizadoEn: ahora() };
  store.set(plantillaId, actualizada);
  return actualizada;
}

export async function eliminarPlantilla(companyId: string, plantillaId: string): Promise<boolean> {
  const actual = await obtenerPlantilla(companyId, plantillaId);
  if (!actual) return false;
  store.delete(plantillaId);
  return true;
}

export async function listarPlantillasPorEmpresaYTipo(
  companyId: string,
  tipoDocumento?: TipoDocumento,
): Promise<PlantillaDocumento[]> {
  return [...store.values()].filter(
    (p) => p.companyId === companyId && (!tipoDocumento || p.tipoDocumento === tipoDocumento),
  );
}

export async function obtenerPlantillaPredeterminada(
  companyId: string,
  tipoDocumento: TipoDocumento,
): Promise<PlantillaDocumento | null> {
  return (
    [...store.values()].find((p) => p.companyId === companyId && p.tipoDocumento === tipoDocumento && p.predeterminada) ?? null
  );
}
