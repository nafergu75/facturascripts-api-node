# Debug: Lector de Facturas — qué verificar en navegador

El income-reader API está 100% funcional (9 documentos en BD). El problema está en la UI.

## Pasos para debuggear:

### 1. ¿La página `/lector` carga?

```
Navegador → http://localhost:5174/lector
```

**Esperado:**
- ✅ Página carga (no 404, no error JS)
- ✅ Título "Lector de Facturas" visible
- ✅ Botón "Subir Factura" visible
- ✅ Area de drop (o file input) visible

**Si error:**
- 404 → ruta no existe (check frontend-chakra/src/App.tsx line 46)
- Error JS → revisar console.log DevTools (click F12)

---

### 2. ¿Está enlazada en el home?

```
Navegador → http://localhost:5174 (home/dashboard)
```

**Buscar:** link o botón a "Lector" o "📄 Income Reader"

**Si no existe:** agregar botón en Home (ver paso 4)

---

### 3. ¿Puedes subir un archivo?

En `/lector`:
1. Click "Subir factura" o drag-drop un PDF
2. Espera 2-3s
3. ¿Aparece en "Documentos Pendientes"?

**Si falla:**
- Revisar Network tab → POST /income-reader/upload (¿200 o 5xx?)
- Revisar Console → ¿errores JS o CORS?

---

### 4. ¿Los documentos cargados muestran datos?

En la tabla "Documentos Pendientes":
- ¿Muestra los 9 documentos que hay en BD?
- ¿Tiene datos (fecha, NIF, bases, totales)?

**Si vacío:**
- Problema: GET /income-reader/pending no carga
- Revisar Network tab → status 200?

---

## Qué reportar

Dime:

1. **¿Llega a `/lector`?**
   - Sí / No / Error (especificar)

2. **¿Qué ve en la página?**
   - Vacía / Botón de upload / Tabla / Etc.

3. **¿Error en Console?** (F12 → Console tab)
   - Sí / No / Qué error

4. **Network tab** (F12 → Network tab):
   - GET `/income-reader/pending` → ¿status?
   - POST `/income-reader/upload` → ¿status?

---

## Quick fix (si falta en home)

Si `/lector` no está enlazada en home, está aquí:
`frontend-chakra/src/pages/Home.tsx`

Agregar botón:
```tsx
<Button as={Link} to="/lector">
  📄 Lector de Facturas
</Button>
```
