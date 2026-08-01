# Asientos Contables - Concepto Básico

## ¿Qué es un asiento contable?

Un asiento es el registro de una operación contable siguiendo el principio de "partida doble":
todo movimiento tiene un Debe y un Haber que siempre suman lo mismo.

### Ejemplo Real

Cuando creas una factura de venta de 1.000€ (más 210€ de IVA):

**Asiento automático generado:**
- DEBE: Clientes 1.210€
- HABER: Ventas 1.000€
- HABER: IVA Repercutido 210€

## Estados del Asiento

1. **DRAFT**: Recién creado, no afecta informes
2. **PENDING_REVIEW**: Esperando aprobación del usuario (es normal)
3. **POSTED**: Aprobado, ya está en balance/PyG (definitivo)
4. **REVERSED**: Anulado (cuando se modifica factura)

## En la App

👉 Ve a **Contabilidad → Asientos** para ver todos
👉 Haz click en uno para ver líneas detalladas
👉 Si está en PENDING, usa botón **Aprobar** para confirmarlo

## Preguntas Frecuentes

**P: ¿Por qué veo "asiento pendiente de revisión"?**
R: Porque la factura fue confirmada pero aún no aprobado contablemente.
Es normal, revisa que los datos sean correctos y haz click en Aprobar.

**P: ¿Puedo editar un asiento POSTED?**
R: No directamente. Debes modificar la factura, y el sistema creará
un nuevo asiento automáticamente (el anterior se marca REVERSED).
