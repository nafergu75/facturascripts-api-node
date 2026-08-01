# ADR-002: Consolidación de spine — Prisma canónico, FacturaScripts legacy

- **Estado:** Aceptado (en ejecución por fases)
- **Fecha:** 2026-06-20
- **Relacionado:** ADR-001 (consolidación del lector OCR)

## Contexto

El proyecto tiene **dos arquitecturas (spines) que se solapan**, cada una con su
propio backend de datos y su propio frontend:

| Función | Spine FacturaScripts (legacy) | Spine Prisma (canónico) |
|---|---|---|
| Facturas | `/facturas/*` (FS `facturaclientes`) | `/invoices/*` (`IncomeInvoice`) |
| Contabilidad | `/contabilidad` (FS, hoy 501) + `/facturas/:id/contabilizar` | `/accounting/*` (`JournalEntry`) |
| Informes | `/reportes/*` (FS, CSV) | `/reports/*` (Prisma) |
| AEAT / fiscal | `/aeat/*`, `/cuentas-anuales/*` (FS) | `/impuestos/*`, `/tax/*` (Prisma) |
| Lector | `/facturas/lector` (legacy, ADR-001) | `/income-reader/*` (canónico) |
| Frontend | `frontend/` (vanilla, :5173) | `frontend-chakra/` (:5174) |

El frontend principal (Chakra) consume **solo el spine Prisma**. El flujo
completo lector → verificar → contabilizar → aprobar → informes funciona
end-to-end sobre Prisma/MySQL **con FacturaScripts apagado** (verificado en real).

## Decisión

**Prisma es el spine canónico.** FacturaScripts pasa a legacy. Razones:

1. El sistema ya opera sin FS — consolidamos sobre lo que es verdad hoy.
2. La inversión reciente y el frontend principal están en Prisma; hacerlos
   canónicos cuesta ~0 cambios de UI. La alternativa (FS canónico) los degradaría
   a adaptadores y multiplicaría el trabajo.
3. Reduce deuda técnica e infraestructura (PHP/FS, `init_tables`, proxy API Key).

No se borra nada todavía: se **marca** (cabeceras `Deprecation` + comentarios) y
se migra por fases.

## Plan por fases y estado

- **Paso 1 — Portar `parsearFacturaeXML` al lector canónico.** ✅ HECHO. El parser
  vive en `income-reader.service.ts`; `procesarOCR` lee XML Facturae sin clave
  Claude; el legacy quedó como shim. Verificado en real (XML → `ocrEstado: OK`).
- **Paso 2 — Marcar el spine FS como legacy.** ✅ HECHO. Middleware
  `deprecation.middleware.ts` aplicado a `facturas`, `reportes`, `contabilidad`,
  `aeat`, `cuentasAnuales` (cabeceras RFC 8594 + comentarios). Sin cambio de
  comportamiento; el frontend vanilla sigue funcionando.
- **Paso 3 — Migrar la fuente de datos AEAT (FS → JournalEntry).** 🟡 PARCIAL.
  - ✅ **Camino por ASIENTOS migrado.** `contabilidadDatos.obtenerAsientosEjercicio`
    (única función que leía FS en ese servicio) ahora lee Prisma `JournalEntry`
    POSTED. Eso re-apunta de golpe a sus 8 consumidores: **cuentas anuales, EFE,
    Modelo 200 (IS), cierre de ejercicio, cuadre de bancos, conciliación,
    extractos y export A3/CSV**. Verificado en real con FS apagado:
    `/cuentas-anuales/*` y `/modelo-200/preview` pasaron de 502 a 200. Los layouts
    no se tocaron. Tests: 223/223 (2 suites actualizadas para inyectar el asiento
    por Prisma en vez de FS).
  - ✅ **Camino por FACTURAS migrado.** `impuestosCalculo.obtenerFacturasFiscales`
    (y la parte de IRPF profesional del Modelo 111) ahora leen `IncomeInvoice`/
    `ExpenseInvoice` (Prisma, excluyendo DRAFT), con IVA desglosado por línea. Los
    agregadores puros (`agregar303/390/347/349`) y los layouts BOE no se tocaron.
    Verificado en real con FS apagado: `/aeat/modelo-303/390/347/preview` pasaron
    de 502 a 200. Tests: 223/223 (2 suites actualizadas para inyectar las facturas
    por Prisma en vez de FS).
  - **Resultado:** el bloque contable y fiscal funciona 100% sin FacturaScripts.
    Queda como spine FS solo lo que el frontend vanilla consume directamente
    (`/facturas` CRUD, etc.), pendiente de los Pasos 4-5.
- **Paso 4 — Retirar el frontend vanilla.** ⏳ PENDIENTE. Solo cuando el Chakra
  cubra todo lo que el vanilla hace. Archivar (`git mv`), no borrar.
- **Paso 5 — Borrado seguro del spine FS.** ⏳ PENDIENTE. Tras Pasos 3-4 + 30 días
  de logs sin tráfico a rutas `Deprecation` + grep global sin referencias.

## Consecuencias

### Positivas
- Dirección arquitectónica explícita y señalizada (headers + comentarios + ADR).
- Una sola fuente de verdad contable (Prisma) para todo lo nuevo.
- Camino de salida claro hacia menos infraestructura.

### Negativas / pendientes
- El spine FS sigue vivo (necesario para el frontend vanilla) hasta el Paso 5.
- **Bloqueo real del Paso 3:** mientras la fuente de datos AEAT no se migre,
  `/impuestos` (Prisma) sigue dependiendo de FS para *recalcular* (lee facturas
  FS); con FS apagado, el *listado* funciona pero el *recálculo* de modelos no.
  Esto es lo que de verdad "termina" el proyecto fiscalmente.

## Lo que NO se toca

- Layouts BOE/AEAT (`impuestosExport.service`): correctos y caros; en el Paso 3
  solo cambia su fuente de datos, nunca el formato.
- 501 contractuales (companies CRUD, contabilidad directa, sales-document create,
  accounting recalculate, inventario): bloqueos explícitos, están bien así.
- `lectorFacturas` legacy: sigue vivo mientras exista el frontend vanilla (ADR-001).
