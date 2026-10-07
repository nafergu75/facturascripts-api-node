-- Arreglo de datos (08-10-2026, rama divisas-iva). Se puede ejecutar mas de una vez sin efectos.
-- Lo aplica scripts/aplicar-arreglos-datos.sh DESPUES del esquema nuevo
-- (columna IncomeInvoice.paisClienteLegacy).
--
-- Las facturas de venta SIN tipo de operacion (todas las anteriores a esta
-- version) se clasifican en el 303, 347, 349 y 390 por el pais de la ficha del
-- cliente. Ahora la ficha permite cambiar el pais: para que un modelo ya
-- presentado no cambie al editarla, se copia en cada una de esas facturas el
-- pais que tiene hoy su cliente, tal cual ('ES', 'FRA', 'US'...). La app lo hace
-- tambien sola justo antes de cambiar el pais de un cliente, asi que este
-- arreglo solo adelanta ese paso para todas.
UPDATE IncomeInvoice f
JOIN Customer c ON c.id = f.customerId
SET f.paisClienteLegacy = COALESCE(c.pais, '')
WHERE f.tipoOperacion IS NULL
  AND f.paisClienteLegacy IS NULL
  AND f.estadoDocumento <> 'PROFORMA';
