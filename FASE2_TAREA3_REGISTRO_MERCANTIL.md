# FASE 2 · TAREA 3 — REGISTRO MERCANTIL: VERSIONADO Y CADUCIDAD

## Objetivo Completado

Implementar soporte para versionado de documentos del Registro Mercantil (Expedientes de Legalización y Depósito de Cuentas Anuales) con control de caducidad, manteniendo cambios mínimos y coherencia con Income Reader.

---

## A. CAMBIOS DE SCHEMA

### Modelos Afectados

#### 1. **LegalizationPackage**
```prisma
model LegalizationPackage {
  // ... campos existentes ...
  version              Int        @default(1)         // Versión del expediente
  expiresAt            DateTime?                       // Fecha de caducidad
  isLatestVersion      Boolean    @default(true)      // ¿Es la versión vigente?
  
  @@index([companyId, isLatestVersion])
  @@index([companyId, expiresAt])
}
```

#### 2. **AnnualAccounts**
```prisma
model AnnualAccounts {
  // ... campos existentes ...
  version              Int        @default(1)         // Versión de las cuentas
  expiresAt            DateTime?                       // Fecha de caducidad
  isLatestVersion      Boolean    @default(true)      // ¿Es la versión vigente?
  
  @@index([companyId, isLatestVersion])
  @@index([companyId, expiresAt])
}
```

### Migración

**Archivo:** `prisma/migrations/add_registro_mercantil_versioning/migration.sql`

```sql
-- Agregar campos a LegalizationPackage
ALTER TABLE `LegalizationPackage` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `LegalizationPackage` ADD COLUMN `expiresAt` DATETIME NULL;
ALTER TABLE `LegalizationPackage` ADD COLUMN `isLatestVersion` BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX `LegalizationPackage_companyId_isLatestVersion_idx`
  ON `LegalizationPackage` (`companyId`, `isLatestVersion`);
CREATE INDEX `LegalizationPackage_companyId_expiresAt_idx`
  ON `LegalizationPackage` (`companyId`, `expiresAt`);

-- Agregar campos a AnnualAccounts
ALTER TABLE `AnnualAccounts` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `AnnualAccounts` ADD COLUMN `expiresAt` DATETIME NULL;
ALTER TABLE `AnnualAccounts` ADD COLUMN `isLatestVersion` BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX `AnnualAccounts_companyId_isLatestVersion_idx`
  ON `AnnualAccounts` (`companyId`, `isLatestVersion`);
CREATE INDEX `AnnualAccounts_companyId_expiresAt_idx`
  ON `AnnualAccounts` (`companyId`, `expiresAt`);
```

**Comando:**
```bash
npx prisma db push
```

---

## B. CAMBIOS DE SERVICIO

### Nuevo Archivo: `src/services/registro-mercantil.service.ts`

#### Helpers

```typescript
export function esVigente(documento: { expiresAt: Date | null }): boolean {
  if (!documento.expiresAt) return true; // Sin caducidad = vigente indefinidamente
  return documento.expiresAt >= new Date();
}

export function calcularCaducidad(diasDesdeHoy: number = 1460): Date {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasDesdeHoy);
  return fecha; // Por defecto: 4 años
}
```

#### Servicio: LegalizationPackage

```typescript
export const legalizationPackageService = {
  /**
   * Crear nuevo expediente.
   * Marca versión anterior como obsoleta automáticamente.
   */
  async crear(
    companyId: string,
    fiscalYearId: string,
    data: { zipPath: string; hash: string; size?: number; registryOffice?: string; expiresAt?: Date }
  ) {
    // Marcar anterior como obsoleta
    await prisma.legalizationPackage.updateMany({
      where: { companyId, fiscalYearId, isLatestVersion: true },
      data: { isLatestVersion: false }
    });
    
    // Calcular próxima versión y crear nuevo
    const proximaVersion = (await this.obtenerUltimaVersion(...)) + 1;
    return prisma.legalizationPackage.create({
      data: {
        version: proximaVersion,
        isLatestVersion: true,
        expiresAt: data.expiresAt || calcularCaducidad(),
        // ... resto de campos
      }
    });
  },

  /**
   * Obtener versión vigente.
   * Lanza error si no existe o está caducada.
   */
  async obtenerVigente(companyId: string, fiscalYearId: string) {
    const documento = await prisma.legalizationPackage.findFirst({
      where: { companyId, fiscalYearId, isLatestVersion: true }
    });
    
    if (!documento) throw notFound('...');
    if (!esVigente(documento)) throw badRequest('El expediente ha expirado.');
    
    return documento;
  },

  /**
   * Detalle con información de vigencia.
   */
  async obtenerDetalle(companyId: string, id: string) {
    const documento = await prisma.legalizationPackage.findFirst({...});
    
    return {
      ...documento,
      esVigente: esVigente(documento),
      diasParaCaducidad: documento.expiresAt ? 
        Math.floor((documento.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null
    };
  }
};
```

#### Servicio: AnnualAccounts

Implementa los mismos métodos que `legalizationPackageService`:
- `crear()` — nueva versión, marca anterior como obsoleta
- `obtenerVigente()` — obtiene versión vigente y no caducada
- `obtenerDetalle()` — devuelve con información de vigencia
- `obtenerHistorial()` — lista todas las versiones (para auditoría)

---

## C. REGLAS DE NEGOCIO

### Flujo de Versionado

#### Primera Subida
```
Input: nuevo expediente
Process:
  - version = 1
  - isLatestVersion = true
  - expiresAt = ahora + 4 años (default)
Output: documento vigente
```

#### Nueva Subida (corrección o actualización)
```
Input: nuevo expediente, mismo fiscalYear
Process:
  1. Actualizar versión anterior: isLatestVersion = false
  2. Crear nuevo con version = N+1
  3. Marcar como isLatestVersion = true
  4. Asignar expiresAt (nuevo o default)
Output: versión anterior obsoleta, nueva vigente
```

#### Consulta de Detalle
```
Input: request a obtenerVigente(companyId, fiscalYearId)
Process:
  1. Buscar con isLatestVersion = true
  2. Validar esVigente()
  3. Si expirado: lanzar badRequest
  4. Si OK: retornar con esVigente=true y diasParaCaducidad
Output: documento vigente + información de caducidad
```

#### Documento Expirado
```
Input: request a obtenerVigente() de documento con expiresAt < ahora
Process:
  1. Encontrar isLatestVersion = true
  2. esVigente() retorna false
  3. Lanzar badRequest("El documento ha expirado")
Output: error + no se procesa el documento
```

---

## D. TESTS

**Archivo:** `src/tests/registro-mercantil-versioning.test.ts`

### Cobertura

#### 1. Helpers (5 tests)
- ✅ Documento vigente sin expiración
- ✅ Documento vigente con fecha futura
- ✅ Documento no vigente con fecha pasada
- ✅ Cálculo de caducidad default (4 años)
- ✅ Cálculo de caducidad personalizado

#### 2. Reglas de Negocio (3 tests)
- ✅ Primera versión siempre es 1
- ✅ isLatestVersion marca versión vigente
- ✅ expiresAt controla período de validez

#### 3. Transiciones de Estado (4 tests)
- ✅ Primera subida crea version 1
- ✅ Nueva subida marca anterior como obsoleta
- ✅ Documento expirado no es válido
- ✅ Solo latest version es usable

#### 4. Respuesta al Cliente (3 tests)
- ✅ Detalle incluye esVigente
- ✅ Detalle incluye diasParaCaducidad
- ✅ Detalle incluye version

#### 5. Flujos de Actualización (4 tests)
- ✅ Primera subida: version=1, isLatestVersion=true
- ✅ Nueva subida: v1 pasa a obsoleta, v2 nueva vigente
- ✅ Documento caduca si expiresAt < ahora
- ✅ Cliente rechazado si intenta usar versión caducada

**Total: 19/19 ✅ en verde**

---

## E. VERIFICACIÓN

### Pasos Ejecutados

```bash
# 1. Regenerar cliente Prisma
npx prisma generate
✅ Generated Prisma Client v5.22.0

# 2. Sincronizar schema con BD
npx prisma db push
✅ Database now in sync (156ms)

# 3. Compilar TypeScript
npm run build
✅ 0 errors, 0 warnings

# 4. Ejecutar tests
npm test -- registro-mercantil-versioning.test.ts
✅ 19/19 tests passed (3.473s)
```

### Criterios de Éxito

| Criterio | Status | Evidencia |
|----------|--------|-----------|
| Schema actualizado (LegalizationPackage) | ✅ | version, expiresAt, isLatestVersion |
| Schema actualizado (AnnualAccounts) | ✅ | version, expiresAt, isLatestVersion |
| Índices creados para búsquedas | ✅ | (companyId, isLatestVersion) y (companyId, expiresAt) |
| Migración aplicada a BD | ✅ | DB sync successful |
| Servicio: LegalizationPackage | ✅ | crear(), obtenerVigente(), obtenerDetalle() |
| Servicio: AnnualAccounts | ✅ | crear(), obtenerVigente(), obtenerDetalle(), obtenerHistorial() |
| Helpers: esVigente() | ✅ | Valida expiración correctamente |
| Helpers: calcularCaducidad() | ✅ | Calcula 4 años (1460 días) por defecto |
| Tests de reglas de negocio | ✅ | 19/19 en verde |
| Compilación sin errores | ✅ | 0 errors TypeScript |
| Coherencia con Income Reader | ✅ | Usa mismo patrón (status, validaciones, helpers) |

---

## DECISIONES DE DISEÑO

### 1. **Sin nuevo estado `EXPIRED`**
- Se usa `isLatestVersion` + `expiresAt` para manejar obsolescencia
- Validaciones en tiempo de consulta (más flexible)
- Coherente con Income Reader

### 2. **Campos mínimos**
- `version`: entero, secuencial
- `expiresAt`: DateTime nullable (sin caducidad = indefinido)
- `isLatestVersion`: booleano (que versión usar)
- NO se agregó `retryCount` (no aplica a Registro Mercantil)

### 3. **Caducidad por defecto: 4 años**
- Período legal de archivo en España
- Configurable por documento si se necesita diferente

### 4. **Dos servicios separados**
- `legalizationPackageService` — expedientes
- `annualAccountsService` — cuentas anuales
- Reutilizan helpers (`esVigente`, `calcularCaducidad`)
- Fácil expandir cada uno según necesidades específicas

---

## RESUMEN TÉCNICO

| Componente | Detalles |
|-----------|----------|
| **Campos agregados** | version (INT), expiresAt (DATETIME), isLatestVersion (BOOL) |
| **Modelos actualizados** | LegalizationPackage, AnnualAccounts |
| **Índices nuevos** | (companyId, isLatestVersion), (companyId, expiresAt) |
| **Helpers implementados** | esVigente(), calcularCaducidad() |
| **Servicios creados** | registro-mercantil.service.ts con 2 servicios |
| **Métodos nuevos** | crear(), obtenerVigente(), obtenerDetalle(), obtenerHistorial() |
| **Tests** | 19 casos cubriendo reglas, transiciones, respuestas |
| **Compilación** | ✅ 0 errores TypeScript |
| **BD Sync** | ✅ Migración aplicada (156ms) |
| **Riesgo** | Bajo (additive, coherente con Income Reader) |

---

## PRÓXIMOS PASOS RECOMENDADOS

1. ✅ **FASE 2 TAREA 3 COMPLETADA** — Versionado y caducidad en Registro Mercantil
2. 🔄 **FASE 2 TAREA 4** — Carmen: persistencia de sesiones (si es necesaria)
3. 📋 **FASE 3** — Rate limiting y naming standardization

---

**Fecha:** 2026-06-30  
**Proyecto:** facturascripts-api-node  
**Alcance:** Registro Mercantil (LegalizationPackage + AnnualAccounts)
