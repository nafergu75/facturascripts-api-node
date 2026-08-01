# ADR-003: API de Registro Mercantil (legalización de libros + depósito de cuentas)

- **Estado:** Aceptado (v1 con stubs de PDF/A)
- **Fecha:** 2026-06-21

## Contexto

Hay que cubrir dos obligaciones registrales españolas al cierre de ejercicio:
1. **Legalización de libros** contables y societarios en el Registro Mercantil
   (plazo: cierre + 4 meses), presentación telemática de un expediente (ZIP con
   huella digital, firmado por el usuario en sede.registradores.org).
2. **Depósito de cuentas anuales** (balance, PyG, memoria) según modelo
   (normal/abreviado/pyme), plazo cierre + 7 meses.

La API **no firma** (no gestiona certificados): genera artefactos (PDF/A, ZIP,
hashes) y registra el estado de la presentación manual.

## Decisión

- **ORM: Prisma** (no TypeORM). Justificación: el proyecto ya usa Prisma como
  ORM único; añadir TypeORM duplicaría migraciones, conexión y tipos. Prisma es
  agnóstico de BD — el spec pedía PostgreSQL pero el proyecto corre sobre MySQL;
  los modelos valen para ambos cambiando solo el `provider` del datasource.
- **Multiempresa:** se reutiliza el modelo existente (`Company`, `User`,
  `Membership` = company_users, `AuditLog`). Los nuevos modelos llevan
  `companyId` y, para rutas de nivel superior sin `companyScope`, el acceso se
  valida con `assertAccesoEmpresa(req.user, recurso.companyId)`.
- **Auth:** se reutiliza `auth.middleware` (JWT → `req.user`) + `companyScope`
  (rutas `/companies/:id/...`) + `authorize('contabilidad:write')` en escrituras.
- **PDF/A y ZIP:** ZIP propio sin dependencias (`utils/zip.ts`, store-only +
  SHA-256). PDF vía `utils/pdf-simple.ts` con **contenido stub** (marcado en el
  código). Balance/PyG salen del motor real (`generarCuentasAnuales`).

## Modelo de datos (Prisma, nuevos)

- `LegalConfig` (1-1 Company): tipoSociedad, ejercicioInicio/Fin, obligaLibroSocios,
  obligaLibroContratos, registroMercantilProvincia.
- `FiscalYear`: label, fechaInicio/Fin, estado (OPEN/CLOSED), closingDate,
  legalizationDeadline, accountsDepositDeadline, asientosBloqueados.
- `LegalBook`: type, filePath, format (PDF/A), hash, status; FK a FiscalYear.
- `LegalizationPackage`: zipPath, hash, size, status, filedAt, registryOffice,
  registryEntryNumber, csv, diligencePath; FK a FiscalYear.
- `AnnualAccounts`: modelo, filePath, dataJson, hash, status, filedAt,
  registryEntryNumber, csv; FK a FiscalYear.

## Máquinas de estado

- **Libro:** PENDING → GENERATED → PACKAGE_READY → FILED → ACCEPTED/REJECTED.
- **Expediente:** CREATED → FILED → ACCEPTED/REJECTED (diligencia = ACCEPTED).
- **Cuentas:** DRAFT → READY → FILED → APROBADO/DEFECTOS/RECHAZADO
  (DEFECTOS permite re-presentar). Validadas en `registroMercantil.model.ts`.

## Plazos

`calcularPlazos(closingDate)`: legalización = +4 meses, depósito = +7 meses, con
**recorte de fin de mes** (31/12 → 30/04, no 01/05). Verificado en test y en real.

## Estructura de ficheros (integrada en el repo)

- `domain/registroMercantil.model.ts` — tipos, estados, plazos.
- `utils/zip.ts` — ZIP store-only + SHA-256.
- `services/registroMercantil.helpers.ts` — acceso + almacenamiento de artefactos.
- `services/{legalConfig,fiscalYears,booksService,legalizationService,annualAccountsService}.ts`
- `controllers/{legalConfig,fiscalYears,books,legalizationPackages,annualAccounts}.controller.ts`
- `routes/{legalConfig,fiscalYears,registroMercantil}.routes.ts` — wired en `routes/index.ts`.
- Almacenamiento: `storage/registro-mercantil/<companyId>/<fiscalYearId>/`.

## Validaciones clave

- No cerrar un ejercicio sin fecha de cierre, ni dos veces.
- No generar libros si el ejercicio no está CERRADO.
- No empaquetar sin libros generados (con PDF).
- Transiciones de estado validadas (expediente y cuentas).
- Resolución de cuentas solo desde FILED y con valor en {APROBADO,DEFECTOS,RECHAZADO}.

## Seguridad y trazabilidad

- Toda escritura/descarga relevante se audita vía `auditoria.service`
  (`registrarAuditoria`): CLOSE_FISCAL_YEAR, GENERATE_BOOKS, DOWNLOAD_BOOK,
  CREATE/FILE_LEGALIZATION_PACKAGE, UPLOAD_DILIGENCE, GENERATE/FILE/RESOLVE
  ANNUAL_ACCOUNTS, etc., con userId + companyId + resourceId.
- Errores con formato unificado (errorMiddleware + http-errors).

## PDF/A real (trabajo futuro)

Los PDF actuales son **stubs** (no PDF/A conformes). Para producción, sustituir
`utils/pdf-simple.ts` por un generador real, idealmente un **microservicio**:
- Node: PDFKit/Puppeteer → post-proceso a PDF/A (ej. Ghostscript `-dPDFA`).
- O servicio externo Java (Apache PDFBox + veraPDF) / Python (ReportLab).
Los servicios `booksService`/`annualAccountsService` solo construyen el contenido
y delegan el "render" — cambiar el render no toca controladores ni rutas.

## Verificación

- Tests: 228/228 (5 nuevos: plazos, ZIP/hash, máquinas de estado).
- Real (FS apagado, solo Prisma): legal-config → crear ejercicio → cerrar
  (plazos 2027-04-30 / 2027-07-31, asientos bloqueados) → deadlines → libros
  PDF/A con hash → expediente ZIP (SHA-256, 2478 B, CREATED) → cuentas READY.
