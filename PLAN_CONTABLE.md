# Plan Contable del Proyecto - Guía de Referencia

## 📍 Ubicación del Plan Contable

El plan contable está definido en:
- **Archivo principal:** `src/services/planContable.service.ts`
- **Definición de tipos:** `src/domain/plan-contable.model.ts`
- **Servicio de gráfico de cuentas:** `src/services/chart-of-accounts.service.ts`

## 🏗️ Estructura del Plan Contable

### Sistema Base (PGC-PYME)

El proyecto implementa el **Plan General de Contabilidad Simplificado (PGC-PYME)** con una estructura jerárquica:

```
Grupos (1-7)
    ├─ Subgrupos (códigos de 2-3 dígitos)
    │    └─ Cuentas Base (códigos de 3 dígitos)
    │         └─ Subcuentas Empresa (códigos de 7 dígitos)
```

### Grupos Contables

| Código | Nombre | Uso |
|--------|--------|-----|
| 1 | Financiación básica | Capital, reservas, deudas LP |
| 2 | Activo no corriente | Inmovilizados, máquinas |
| 3 | Existencias | Inventarios, stock |
| 4 | Acreedores y deudores | Clientes, proveedores, HP |
| 5 | Cuentas financieras | Bancos, caja, tesorería |
| 6 | Compras y gastos | Gastos operativos, COGS |
| 7 | Ventas e ingresos | Ventas, servicios, ingresos |

## 💼 Cuentas Principales para Facturas

### Cuentas de INGRESOS (Grupo 7)

```typescript
// Ventas e ingresos
700 - Ventas de mercaderías
705 - Prestaciones de servicios
769 - Otros ingresos financieros
```

### Cuentas de GASTOS (Grupo 6)

```typescript
// Compras y aprovisionamientos
600 - Compras de mercaderías
602 - Compras de otros aprovisionamientos

// Servicios exteriores
621 - Arrendamientos y canones
622 - Reparaciones y conservación
626 - Servicios bancarios y similares
627 - Publicidad, propaganda y relaciones públicas
628 - Suministros
629 - Otros servicios

// Gastos de personal
640 - Sueldos y salarios
642 - Seguridad Social a cargo de la empresa
```

### Cuentas de Clientes y Proveedores (Grupo 4)

```typescript
// Deudores
430 - Clientes
440 - Deudores

// Acreedores
400 - Proveedores
410 - Acreedores por prestaciones de servicios

// Hacienda Pública
470 - Hacienda Pública deudora
472 - Hacienda Pública, IVA soportado
475 - Hacienda Pública, acreedora por conceptos fiscales
477 - Hacienda Pública, IVA repercutido
```

### Cuentas Financieras (Grupo 5)

```typescript
// Tesorería
570 - Caja, euros
572 - Bancos e instituciones de crédito c/c vista, euros

// Deudas CP
520 - Deudas a corto plazo con entidades de crédito
```

## 🔧 Cómo Usar el Plan Contable en el Código

### 1. Obtener lista de cuentas base

```typescript
import { listarCuentasBase, listarGruposBase, listarSubgruposBase } from '../services/planContable.service';

// Todas las cuentas del PGC-PYME
const cuentas = listarCuentasBase();

// Filtrar gastos (grupo 6)
const gastosDisponibles = cuentas.filter(c => c.tipo === 'gasto');

// Filtrar servicios exteriores (subgrupo 62)
const servicios = cuentas.filter(c => c.subgrupoCodigo === '62');
```

### 2. Sugerir cuenta para una factura

**Regla: NUNCA inventar cuentas. Usar SIEMPRE del plan base.**

```typescript
// ❌ NUNCA: No crear cuenta propia
const cuenta = { codigo: '800', nombre: 'Cuenta inventada' };

// ✅ SIEMPRE: Usar del plan contable
function sugerirCuentaParaGasto(descripcion: string) {
  const cuentas = listarCuentasBase();
  
  // Analizar descripción y mapear a cuenta existente
  if (descripcion.includes('arrendamiento')) {
    return cuentas.find(c => c.codigo === '621'); // Arrendamientos
  }
  if (descripcion.includes('publicidad')) {
    return cuentas.find(c => c.codigo === '627'); // Publicidad
  }
  if (descripcion.includes('suministros')) {
    return cuentas.find(c => c.codigo === '628'); // Suministros
  }
  
  // Default: Otros servicios
  return cuentas.find(c => c.codigo === '629');
}
```

### 3. Validar que una cuenta existe

```typescript
function validarCuenta(codigo: string): boolean {
  const cuentas = listarCuentasBase();
  return cuentas.some(c => c.codigo === codigo);
}

// Uso en asientos
if (!validarCuenta(codigoIngresado)) {
  throw new Error(`Cuenta ${codigoIngresado} no existe en el plan contable`);
}
```

## 📋 Mapa de Cuentas por Tipo de Operación

### Factura de INGRESO (venta)

```
Débito:  430 (Clientes)              | Crédito: 700/705 (Ventas/Servicios)
         472 (IVA soportado)         |          477 (IVA repercutido)
```

### Factura de GASTO (compra)

```
Débito:  600/602/62x/64x (Gastos)    | Crédito: 400 (Proveedores)
         472 (IVA soportado)         |          477 (IVA repercutido)
```

### Retención (IRPF)

```
Débito:  473 (HP retenciones)  | Crédito: 700/705 (reducción de ingreso)
         4751 (HP acr. por ret.) | Débito:  600/62x/64x (reducción de gasto)
```

## ⚠️ Restricciones Importantes

1. **Nunca inventar cuentas**: Si una cuenta no está en `listarCuentasBase()`, no la uses.
2. **Validar siempre**: Antes de sugerir una cuenta, verificar que existe.
3. **Usar tipos correctos**: Gastos solo del grupo 6, ingresos solo del grupo 7.
4. **Respetar subgrupos**: Cada subgrupo (62, 64, etc.) agrupa conceptos relacionados.

## 🔍 Cómo Encontrar una Cuenta

Si necesitas una nueva cuenta que no exista:

1. **Busca en el plan base** (`listarCuentasBase()`)
2. Si no existe, propón la más cercana existente
3. **NO la crees**: Indica que falta en el plan contable y sugiere una alternativa

### Ejemplo

Usuario pide: "Quiero contabilizar un gasto de capacitación de empleados"

```typescript
// Búsqueda
const capacitacion = listarCuentasBase().find(c => c.codigo === '640'); // No existe
const formacion = listarCuentasBase().find(c => c.codigo === '629'); // Otros servicios

// Solución
console.log('Cuenta 640 (capacitación) no existe en el plan base.');
console.log('Se sugiere usar 629 (Otros servicios) que es la más cercana.');
```

## 📚 Referencias en el Código

- **Extractor IA de facturas**: Usa `listarCuentasBase()` para sugerir cuentas según OCR
- **Asientos contables**: Valida siempre que la cuenta existe antes de crear asiento
- **Sugerencias contables**: Mapea descripción de factura a cuenta del plan base
- **Reportes**: Agrupa cuentas por grupo/subgrupo para análisis

---

**Fecha de creación:** 2026-07-18  
**Versión del PGC:** PGC-PYME (simplificado 1-7)  
**Mantenedor:** Conta API
