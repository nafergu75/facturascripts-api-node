# 📊 Guía del Dashboard de Endpoints

**Archivo:** `dashboard.html`

---

## 🚀 Cómo Usar

### 1️⃣ Abrir el Dashboard

```bash
# Opción A: Abrir directamente en navegador
open dashboard.html

# Opción B: Via servidor local
python3 -m http.server 8000
# Luego ir a: http://localhost:8000/dashboard.html
```

### 2️⃣ Cargar Datos

**Opción A: Datos de Ejemplo**
- Click en botón "📝 Datos de Ejemplo"
- Muestra 9 endpoints con 20 peticiones

**Opción B: Tus Propios Logs**
1. Click en input "Carga logs/requests.jsonl"
2. Selecciona tu archivo de logs
3. Dashboard se actualiza automáticamente

**Requisitos:**
- `endpoints.json` en la misma carpeta
- `logs/requests.jsonl` o tu archivo personalizado

---

## 📈 Paneles del Dashboard

### Estadísticas Principales
- **Total Endpoints:** Todos los definidos
- **Vivos (Usados):** Encontrados en logs
- **Muertos (Sin uso):** No aparecen en logs
- **% Usado:** Porcentaje de cobertura

### Gráficos
1. **Endpoints por Scope**
   - Pie chart: públicos vs protegidos vs scopeados

2. **Actividad por Hora**
   - Histograma: distribución temporal de peticiones

3. **Solicitudes por Método HTTP**
   - Barra: GET, POST, PATCH, DELETE

### Módulos y Uso
- Grid visual de cada módulo
- Cantidad de endpoints usados
- Porcentaje de uso por módulo

### Tabla de Endpoints Vivos
- Búsqueda en tiempo real
- Método HTTP, ruta, módulo, scope
- Filtrable y exportable

---

## 🎯 Flujo Completo

### Para Análisis Local

```bash
# 1. Generar datos
npm run script:list-endpoints
npm test -- src/tests/integration-endpoints.test.ts

# 2. Abrir dashboard.html en navegador
# 3. Click "📝 Datos de Ejemplo" o cargar logs
# 4. Explorar gráficos
# 5. Exportar CSV si quieres
```

### Para Análisis de Producción

```bash
# 1. Descargar logs de Vercel/Railway
# Copiar a: logs/requests.jsonl

# 2. Generar reporte
npm run script:find-dead-endpoints

# 3. Abrir dashboard
# Input: selecciona logs/requests.jsonl
# Endpoints.json se carga automáticamente

# 4. Visualizar y analizar
```

---

## 💾 Exportar Resultados

### Botón "📥 Exportar CSV"
Descarga CSV con:
- Método HTTP
- Ruta
- Módulo
- Scope
- Estado (VIVO/MUERTO)

**Usar en Excel/Sheets para:**
- Filtrar por estado
- Agrupar por módulo
- Crear reportes ejecutivos

---

## 🔍 Características

### Búsqueda en Tiempo Real
- Input en sección "Endpoints Vivos"
- Filtra tabla mientras escribes
- Ejemplo: buscar "auth" → muestra solo endpoints de auth

### Datos Visuales
- Gráficos interactivos (Chart.js)
- Responsive (mobile-friendly)
- Temas degradados modernos

### Sin Dependencias Backend
- HTML + JavaScript puro
- Abre en cualquier navegador
- No requiere servidor

### Carga de Archivos Local
- Carga `endpoints.json` automáticamente
- Carga logs desde input file
- Todo en cliente (privado)

---

## 📊 Interpretación de Datos

### Ejemplo: Datos de Producción Real

**Escenario:**
```
Total: 172 endpoints
Vivos: 45 (26%)
Muertos: 127 (74%)
```

**Análisis:**
| Módulo | Total | Usados | % | Acción |
|--------|-------|--------|---|--------|
| auth | 5 | 5 | 100% | ✅ CRÍTICO |
| clientes | 6 | 2 | 33% | ⚠️ REVISAR |
| reportes | 11 | 0 | 0% | 🚨 DEPRECATE |
| impuestos | 13 | 8 | 62% | ✅ CORE |

### Recomendaciones
- **100% de uso:** Mantener, documentar
- **>50% uso:** Importante, mantener
- **<50% uso:** Revisar con Product
- **0% uso:** Candidato a deprecated

---

## 🎨 Colores del Dashboard

| Color | Significado |
|-------|-------------|
| 🟢 Verde | Endpoints vivos, usados |
| 🔴 Rojo | Endpoints muertos, sin uso |
| 🟣 Púrpura | Gradiente principal |
| 🔵 Azul | Scope "protected" |
| 🟡 Amarillo | Scope "protected" |
| 🟣 Violeta | Scope "scoped" |

---

## 🔧 Personalización

### Cambiar Datos de Ejemplo

Edita en `dashboard.html`, función `loadExample()`:

```javascript
const exampleLogs = [
    {timestamp:"2026-06-30T10:00:00.000Z",method:"GET",path:"/health",...},
    // Agregar más peticiones
];

const exampleEndpoints = [
    {method:"GET",path:"/health",file:"app.ts",...},
    // Agregar más endpoints
];
```

### Cambiar Colores

Edita en `<style>`:
```css
.btn-primary {
    background: #667eea;  /* Cambiar color */
}
```

---

## 📱 Responsive

Dashboard adapta a:
- 📺 Desktop (1400px+)
- 💻 Tablet (768px+)
- 📱 Mobile (320px+)

---

## ⚡ Tips

### Para Análisis Rápido
1. Abre dashboard
2. Click "📝 Datos de Ejemplo"
3. Ves gráficos al instante

### Para Análisis Profundo
1. Carga logs reales
2. Usa búsqueda para filtrar por módulo
3. Exporta CSV
4. Lleva a Excel para análisis avanzado

### Para Presentaciones
- Toma screenshots de gráficos
- Usa exportación CSV en reportes
- Muestra % de cobertura a stakeholders

---

## 🐛 Solución de Problemas

### "Falta endpoints.json"
- El dashboard busca `endpoints.json` en la misma carpeta
- Ejecuta `npm run script:list-endpoints` primero

### "Error al cargar archivo"
- Verifica que el archivo esté en formato JSON Lines
- Una línea JSON por petición
- Sin saltos de línea extras

### Datos no aparecen
- Recarga página (F5)
- Verifica navegador console (F12)
- Intenta con "📝 Datos de Ejemplo"

---

## 📖 Documentación Relacionada

- `INTEGRATION-TESTS-SUMMARY.md` — Cómo generar logs
- `AUDIT-ENDPOINTS-CLASSIFICATION.md` — Análisis detallado de endpoints
- `DEAD-ENDPOINTS-GUIDE.md` — Guía completa de decisiones

---

## 🎓 Resumen

**Dashboard = Visualización en tiempo real de:**
- ✅ Qué endpoints se usan
- 📊 Cómo se distribuye el tráfico
- 🎯 Módulos críticos vs legacy
- 📈 Tendencias de uso

**Usa para:**
- Auditorías de endpoints
- Decisiones de deprecated
- Reportes ejecutivos
- Monitoreo continuo

---

**¡Listo para explorar tu API! 🚀**
