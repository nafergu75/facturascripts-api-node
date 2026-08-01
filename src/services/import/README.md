# Sistema de Importación de Datos Contables Históricos

Sistema completo para importar datos contables de años anteriores a Conta API, permitiendo inicializar la contabilidad de 2026 con balances históricos.

## Arquitectura

El sistema está organizado en 7 servicios especializados que se orquestan mediante `ImportService`:

### 1. **FileParserService**
Lee archivos Excel (XLSX/XLS) y CSV con detección automática de:
- Hojas en Excel
- Delimitadores en CSV (coma vs punto y coma)
- Codificación de caracteres

**Métodos principales:**
- `parseFile(filePath, sheetName?)` - Lee y parsea archivos
- `getFileInfo(filePath)` - Obtiene metadatos (tamaño, filas, columnas)

### 2. **ColumnNormalizerService**
Normaliza datos brutos en formatos estándar:
- Conversión de números españoles (1.234,56) a formato decimal (1234.56)
- Parseo de fechas múltiples (DD/MM/YYYY, YYYY-MM-DD, etc.)
- Limpieza de espacios en blanco
- Sugerencia automática de mapeos de columnas (Levenshtein similarity)

**Métodos principales:**
- `suggestColumnMapping(headersOriginales, headersEsperados)` - Sugiere mapeos
- `normalizeRow(row, mapping)` - Normaliza una fila
- `detectAnomalies(rows)` - Detecta columnas vacías, valores sospechosos

### 3. **AccountMapperService**
Mapea códigos de cuenta de formatos variados al formato PGC-PYME (6 dígitos):
- Detecta automáticamente 4-dígitos, 5-dígitos y otros formatos
- Convierte a formato interno: 4-dígitos (1000) → 6-dígitos (100000)
- Soporta mapeos manuales personalizados
- Categoriza cuentas por naturaleza (Activo/Pasivo/Patrimonio/etc)

**Métodos principales:**
- `mapAccountCode(originCode, manualMappings?)` - Mapea un código
- `suggestMappings(accountCodes, manualMappings?)` - Sugiere mapeos en lote
- `categorizeAccount(code)` - Categoriza por tipo de cuenta
- `validateAccountCodeStructure(code)` - Valida estructura

### 4. **BalanceValidatorService**
Valida que el Balance de Situación sea correcto (partida doble):

**Validaciones:**
- `Activo = Pasivo + Patrimonio Neto` (debe cuadrar)
- Detecta cuentas de naturaleza mixta
- Valida consistencia estructural
- Calcula índices de solvencia

**Métodos principales:**
- `validateBalance(rows)` - Valida balance completo
- `analyzeStructure(result)` - Calcula ratios de equidad y solvencia
- `validateAccountMappings(rows)` - Verifica códigos mapeables
- `compareWithPriorYear(current, prior)` - Compara años consecutivos

### 5. **MayorValidatorService**
Valida consistencia del Mayor/Ledger:

**Validaciones:**
- `Debe = Haber` (partida doble)
- Consistencia entre Mayor y Balance
- Rango de fechas válidas
- Detección de anomalías contables

**Métodos principales:**
- `validateMayor(rows)` - Valida mayor completo
- `compareWithBalance(mayorResult, balanceBalances)` - Cruza Mayor ↔ Balance
- `detectAnomalies(result)` - Encuentra patrones sospechosos
- `analyzeTemporalPatterns(result)` - Análisis de fechas y periodicidad

### 6. **ImportSessionService**
Gestiona el ciclo de vida de una sesión de importación:

**Estados:**
```
INICIADO → PARSEADO → MAPEADO → VALIDADO → IMPORTADO
   ↓          ↓          ↓          ↓          ↑
   └─────────→ FALLIDO ←─────────────────────┘
```

**Métodos principales:**
- `createSession(data)` - Crea nueva sesión
- `transitionState(sessionId, newState)` - Cambia estado (con validación)
- `getProgress(sessionId)` - Obtiene porcentaje completado
- `validateReadiness(sessionId)` - Verifica si puede avanzar

### 7. **OpeningEntryGeneratorService**
Genera asientos de apertura (opening entries) para 2026 basados en saldos previos:

**Validaciones:**
- El asiento cuadra (Debe = Haber)
- Filtra cuentas de resultado (ingresos/gastos cierran)
- Genera líneas de corrección si hay redondeos
- Exporta en JSON/CSV

**Métodos principales:**
- `generateOpeningEntry(historicalBalances, newYear)` - Genera asiento
- `validateOpeningEntry(entry)` - Valida estructura
- `exportAsJSON(entry)` - Exporta JSON
- `exportAsCSV(entry)` - Exporta CSV

### 8. **ImportService** (Orquestador)
Coordina el flujo completo de importación:

```
Upload → Parse → Normalize → Map → Validate → Generate Opening Entry → Import
```

**Métodos principales:**
- `importHistoricalData(data)` - Flujo completo
- `getImportStatus(sessionId)` - Estado actual
- `getImportProgress(sessionId)` - Porcentaje y detalles
- `cancelImport(sessionId)` - Cancela importación en curso

## Flujo de Importación

### 1. Upload
```typescript
const importService = new ImportService();
const result = await importService.importHistoricalData({
  companyId: '1',
  importType: 'BALANCE',
  ejercicio: 2025,
  filePath: '/uploads/balance_2025.xlsx',
  fileName: 'balance_2025.xlsx',
  userId: 'user123',
  sheetName: 'Balance', // opcional
});
```

### 2. Mapping (Automático + Manual)
El sistema sugiere mapeos automáticamente. Si necesitas sobrescribir:

```typescript
const manualMappings = {
  'Código Cuenta': 'cuentaCodigo',
  'Saldo Deudor': 'debe',
  'Saldo Acreedor': 'haber',
};

const result = await importService.importHistoricalData({
  // ... resto de datos
  manualAccountMappings: {
    '1000': '100000',  // Mapear código origen a interno
    '5000': '500000',
  },
});
```

### 3. Validación Automática
Durante la validación se verifica:
- Balance cuadra
- Mayor es consistente
- Códigos de cuenta son válidos
- Fechas están en rango válido
- Detecta anomalías

### 4. Generación de Asiento de Apertura
Si todo es válido, se genera automáticamente:
- Asiento de apertura 2026/00001 del 1 de enero
- Líneas para cada cuenta con saldo
- Balances exactos (Debe = Haber)

### 5. Resultado Final
```typescript
{
  sessionId: 'import_123456789_abc123',
  success: true,
  ejercicio: 2025,
  importType: 'BALANCE',
  totalRows: 150,
  processedRows: 150,
  errorRows: 0,
  duration: '2.5s',
  openingEntry: { /* asiento de apertura generado */ },
  validationResult: { /* detalles de validación */ },
  errors: [],
  warnings: ['Cuenta 572000 tiene saldo negativo (mixta)'],
}
```

## Formato de Entrada

### Balance (BALANCE)
Columnas esperadas (automáticamente detectadas):
- `Cuenta` o `Code`: Código de cuenta (4-6 dígitos)
- `Nombre Cuenta` o `Description`: Nombre descriptivo
- `Debe` o `Debit`: Saldo deudor (números con . o ,)
- `Haber` o `Credit`: Saldo acreedor
- `Categoría` (opcional): ACTIVO, PASIVO, PATRIMONIO

**Ejemplo:**
```
Código | Nombre Cuenta        | Debe      | Haber
1000   | Caja y Bancos       | 50000.00  | 0.00
4100   | Clientes            | 30000.00  | 0.00
2100   | Proveedores         | 0.00      | 20000.00
```

### Mayor (MAYOR)
Columnas esperadas:
- `Fecha` o `Date`: Formato DD/MM/YYYY o YYYY-MM-DD
- `Cuenta` o `Account`: Código de cuenta
- `Descripción` o `Description`: Concepto
- `Debe` o `Debit`: Cantidad en debe
- `Haber` o `Credit`: Cantidad en haber

**Ejemplo:**
```
Fecha      | Cuenta | Descripción           | Debe     | Haber
01/01/2025 | 1000   | Saldo apertura caja  | 50000.00 | 0.00
05/01/2025 | 4100   | Factura cliente ABC  | 30000.00 | 0.00
10/01/2025 | 2100   | Factura proveedor XYZ| 0.00     | 20000.00
```

## Ejemplo Completo

```typescript
import { ImportService } from './services/import/import.service';

async function importarBalance2025() {
  const importService = new ImportService();

  try {
    // Ejecutar importación
    const result = await importService.importHistoricalData({
      companyId: 'empresa-001',
      importType: 'BALANCE',
      ejercicio: 2025,
      filePath: '/datos/balance_2025.xlsx',
      fileName: 'balance_2025.xlsx',
      userId: 'admin@empresa.es',
      sheetName: 'Balance Sheet',
      manualAccountMappings: {
        // Mapeos personalizados si es necesario
        '600': '600000',
      },
    });

    if (result.success) {
      console.log('✅ Importación exitosa');
      console.log(`📊 Filas procesadas: ${result.processedRows}/${result.totalRows}`);
      console.log(`⏱️  Duración: ${result.duration}`);
      
      // El asiento de apertura está disponible
      if (result.openingEntry) {
        console.log(`📝 Asiento generado: ${result.openingEntry.numero}`);
        console.log(`   Debe: ${result.openingEntry.totalDebe}`);
        console.log(`   Haber: ${result.openingEntry.totalHaber}`);
      }
    } else {
      console.error('❌ Importación fallida');
      result.errors.forEach((e) => console.error(`  - ${e}`));
    }

    // Advertencias (no críticas)
    if (result.warnings.length > 0) {
      console.warn('⚠️  Advertencias:');
      result.warnings.forEach((w) => console.warn(`  - ${w}`));
    }

    // Monitorear progreso
    const progress = importService.getImportProgress(result.sessionId);
    console.log(`Progreso: ${progress?.percentage}%`);

  } catch (error) {
    console.error('Error:', error);
  }
}

// Ejecutar
importarBalance2025();
```

## Manejo de Errores

El sistema detecta y reporta:

| Tipo | Gravedad | Ejemplo |
|------|----------|---------|
| **Critical** | 🔴 Detiene | Balance no cuadra: Activo ≠ Pasivo + PN |
| **Error** | 🔴 Detiene | Código de cuenta inválido (no 6 dígitos) |
| **Warning** | 🟡 Continúa | Cuenta de Activo con saldo negativo (mixta) |
| **Info** | 🟢 Log | 250 filas procesadas exitosamente |

## Próximos Pasos

1. **Crear endpoints API** para exponer este flujo:
   - `POST /import/upload` - Sube archivo
   - `GET /import/:sessionId/mapping` - Obtiene mapeos sugeridos
   - `POST /import/:sessionId/validate` - Valida datos
   - `POST /import/:sessionId/confirm` - Confirma e importa

2. **Crear componentes UI** para wizard 4-paso:
   - Step 1: Upload
   - Step 2: Column Mapping
   - Step 3: Validation Review
   - Step 4: Confirmation & Opening Entry

3. **Implementar persistencia**:
   - Guardar sesiones en base de datos
   - Almacenar datos históricos (optional)
   - Audit trail de importaciones

4. **Agregar tests**:
   - Unit tests para cada servicio
   - Integration tests para flujo completo
   - Test fixtures con datos de ejemplo

## Notas Técnicas

- **Precisión decimal**: Usa `Decimal` de Prisma (no `number`)
- **Tolerancia de redondeo**: 0.01 EUR por defecto
- **Timezone**: Maneja fechas en UTC
- **Validación doble**: Balance + Mayor siempre se validan
- **Session timeout**: Las sesiones se limpian después de 24h inactivas
