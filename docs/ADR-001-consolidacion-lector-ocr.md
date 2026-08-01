# ADR-001: Consolidación de lector OCR — income-reader como canónico

- **Estado:** Aceptado
- **Fecha:** 2026-06-20

## Contexto

El proyecto tenía **dos sistemas paralelos** de lectura de facturas que resolvían
el mismo problema (subir PDF/imagen/XML → extraer datos → crear factura), con
código distinto y comportamiento divergente:

1. **`income-reader`** (`src/services/income-reader.service.ts` + `income-reader.routes.ts`)
   - Persistencia real en BD (tabla Prisma `IncomeReaderDocument`).
   - Consumido por el **frontend Chakra** (`frontend-chakra/`, puerto 5174) en `/lector`,
     vía `src/api/incomeReaderApi.ts`.
   - Rutas: `/companies/:companyId/income-reader/*`.
   - Estados: `UPLOADED → READY_FOR_VERIFICATION → VERIFIED` (o `REJECTED`).
   - OCR real con Claude vision (`claude-opus-4-8`, tool-calling).

2. **`lectorFacturas`** (`src/services/lectorFacturas.service.ts` + `lectorFacturas.routes.ts`)
   - Persistencia **en memoria** (`Map`), sin tabla propia.
   - Consumido por el **frontend vanilla antiguo** (`frontend/`, puerto 5173).
   - Rutas: `/companies/:companyId/facturas/lector/*` (montadas vía `facturas.routes.ts`).
   - Estados: `pendiente_revision → confirmada / descartada`.
   - Tenía su **propia** integración con Claude (duplicada) **+** un parser de
     Facturae XML propio que income-reader no tiene.

Un comentario en `lectorFacturas.routes.ts` afirmaba "DEAD CODE — no registrado",
lo cual era **falso**: las rutas estaban vivas y el frontend vanilla las usaba.
Esto generaba duplicidad de la integración con Claude, rutas "medio vivas" y
riesgo de comportamiento inconsistente entre ambos lectores.

## Decisión

- **`income-reader` es el lector CANÓNICO** del proyecto. Toda nueva
  funcionalidad y la UI nueva (frontend Chakra) se construyen sobre él.
- La **integración con Claude vive en un único sitio**: `procesarOCR` de
  `income-reader.service.ts` (exportada). El OCR de PDF/imagen de `lectorFacturas`
  **delega** en esa función y mapea el resultado a su forma legacy. Se elimina
  así la duplicación de la llamada a Claude.
- **`lectorFacturas` pasa a LEGACY**, pero se **mantiene vivo** porque el
  frontend vanilla todavía lo consume. Se conserva intacta su forma de respuesta
  (`FacturaLeida`) y su parser Facturae XML (único capability propio).
- Las rutas legacy emiten **cabeceras de deprecación** (RFC 8594):
  `Deprecation: true`, `Link: <…/income-reader>; rel="successor-version"` y un
  `Warning` apuntando al sucesor.
- Service, controller, routes y el frontend vanilla quedan marcados en código
  como **legacy** con punteros al lector canónico.
- **No se borra código legacy** (instrucción explícita): solo se encapsula,
  documenta y deprecia.

## Consecuencias

### Positivas
- Un único punto de integración con Claude (sin duplicación); cualquier mejora
  de OCR beneficia a ambos lectores.
- El frontend Chakra y todo lo nuevo apuntan a un solo lector con persistencia real.
- Las rutas legacy son ahora explícitamente legacy (cabeceras + comentarios),
  sin ambigüedad ni comentarios falsos ("DEAD CODE").
- Cero rupturas: el frontend vanilla sigue funcionando con la misma respuesta.

### Negativas / pendientes
- Sigue existiendo código legacy (`lectorFacturas.*` + página del frontend
  vanilla) hasta que el frontend vanilla se retire o migre a income-reader.
- `lectorFacturas` persiste en memoria (`Map`): los borradores no sobreviven a un
  reinicio. No se migra; se deprecará junto con el frontend vanilla.
- El parser Facturae XML solo existe en el lector legacy. Si se retira
  `lectorFacturas`, conviene **portar `parsearFacturaeXML` a income-reader** antes
  de eliminarlo (capability que el canónico aún no tiene).
- No hay tablas Prisma duplicadas que deprecar: el legacy no tiene tabla propia.

## Trabajo futuro (no incluido en esta decisión)
1. Migrar el frontend vanilla a income-reader, o retirarlo.
2. Portar `parsearFacturaeXML` a income-reader (soporte XML en el canónico).
3. Tras 1 y 2, eliminar `lectorFacturas.*` y su página en el frontend vanilla.
