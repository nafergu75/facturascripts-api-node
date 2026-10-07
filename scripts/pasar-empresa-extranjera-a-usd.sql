-- PASO MANUAL (NO lo ejecuta scripts/aplicar-arreglos-datos.sh).
--
-- Pasa a dolares (USD) la contabilidad de UNA empresa de EE. UU. o Hong Kong
-- que ya tenia facturas o asientos antes de la version de divisas: la columna
-- nueva LegalConfig.monedaCuenta se creo con 'EUR' para todas, y con documentos
-- la app ya no deja cambiarla. Las empresas de EE. UU. y Hong Kong trabajan
-- solo en USD.
--
-- ANTES de ejecutarlo:
--  1) Lista las empresas afectadas:
--       SELECT l.companyId, l.denominacion, l.pais, l.monedaCuenta,
--              (SELECT COUNT(*) FROM IncomeInvoice f WHERE f.companyId = l.companyId) AS facturas,
--              (SELECT COUNT(*) FROM JournalEntry a WHERE a.companyId = l.companyId) AS asientos,
--              (SELECT COUNT(*) FROM Nomina n WHERE n.companyId = l.companyId AND n.estado <> 'ANULADA') AS nominas
--       FROM LegalConfig l
--       WHERE l.pais IN ('US', 'HK') AND l.monedaCuenta = 'EUR';
--  2) Confirma con la empresa que TODAS sus cifras (facturas, asientos, saldos y
--     cuentas bancarias) son dolares. Si alguna esta de verdad en euros, NO lo
--     ejecutes: esa parte habria que convertirla a mano. Si tiene nominas, NO lo
--     ejecutes: son de la Seguridad Social y el IRPF espanoles, en euros.
--  3) Cambia PON_AQUI_EL_ID_DE_LA_EMPRESA por su companyId en las cinco sentencias.
--
-- Ejecucion (Git Bash, carpeta backend, con DATABASE_URL de produccion):
--   npx prisma db execute --file scripts/pasar-empresa-extranjera-a-usd.sql --schema prisma/schema.prisma
-- Sin cambiar el id no hace nada. Se puede ejecutar mas de una vez.

-- 1) La contabilidad de la empresa, en USD (solo si es de EE. UU. o Hong Kong).
UPDATE LegalConfig
SET monedaCuenta = 'USD'
WHERE companyId = 'PON_AQUI_EL_ID_DE_LA_EMPRESA'
  AND pais IN ('US', 'HK')
  AND monedaCuenta = 'EUR';

-- 2) Sus cuentas bancarias.
UPDATE BankAccount b
JOIN LegalConfig l ON l.companyId = b.companyId
SET b.moneda = 'USD'
WHERE b.companyId = 'PON_AQUI_EL_ID_DE_LA_EMPRESA'
  AND l.pais IN ('US', 'HK') AND l.monedaCuenta = 'USD'
  AND b.moneda = 'EUR';

-- 3) Sus facturas de venta (sus importes ya eran dolares; tipo 1, la moneda de la contabilidad).
UPDATE IncomeInvoice f
JOIN LegalConfig l ON l.companyId = f.companyId
SET f.moneda = 'USD'
WHERE f.companyId = 'PON_AQUI_EL_ID_DE_LA_EMPRESA'
  AND l.pais IN ('US', 'HK') AND l.monedaCuenta = 'USD'
  AND f.moneda = 'EUR' AND f.tipoCambio = 1;

-- 4) Sus cobros y pagos.
UPDATE InvoicePayment p
JOIN LegalConfig l ON l.companyId = p.companyId
SET p.moneda = 'USD'
WHERE p.companyId = 'PON_AQUI_EL_ID_DE_LA_EMPRESA'
  AND l.pais IN ('US', 'HK') AND l.monedaCuenta = 'USD'
  AND p.moneda = 'EUR' AND p.tipoCambio = 1;

-- 5) Sus facturas archivadas (no los PDF de nominas ni de seguros sociales).
UPDATE DocumentoArchivo d
JOIN LegalConfig l ON l.companyId = d.companyId
SET d.moneda = 'USD'
WHERE d.companyId = 'PON_AQUI_EL_ID_DE_LA_EMPRESA'
  AND l.pais IN ('US', 'HK') AND l.monedaCuenta = 'USD'
  AND d.tipo IN ('ingreso', 'gasto')
  AND d.moneda = 'EUR';
