# ADR-004: Nóminas, fuente única del 111 y del 190, y sus pagos

- **Estado:** Aceptado
- **Fecha:** 2026-10-07

## Contexto

Las nóminas las calcula la gestoría. La app las registra (una por trabajador y
mes, importadas del Excel que manda cada mes), las contabiliza con un asiento
por trabajador y su subcuenta 465 propia, y las tiene que llevar al resto:
tesorería, modelo 111, modelo 190 y archivo.

Hasta ahora había dos cálculos del 111 que se pisaban en `ModeloImpuesto`:

- `impuestosCalculo.calcularModelo111` (módulo Impuestos: casillas oficiales y
  TXT) leía el resumen mensual de nóminas y contaba como perceptores los meses,
  no las personas (3 meses x 10 trabajadores daba casilla 01 = 3).
- `tax-models.generarModelo111` (pantalla de modelos fiscales) leía
  `RetentionBook`, guardaba otro formato de casillas y de datos, y el 190 sumaba
  `datos.totalBase` de esas filas. Según cuál se hubiera abierto el último, el
  TXT o el 190 salían mal.

## Decisión

1. **Una sola fuente**: `services/nominas/fiscal.ts`.
   - Trabajo: la tabla `Nomina`, no `RetentionBook`. Se leen las nóminas no
     anuladas (las de borrador también, con aviso).
   - **Por fecha de pago** (art. 78.1 RIRPF: la obligación de retener nace al
     pagar). Una nómina de diciembre pagada en enero va al 1T siguiente. Al
     registrar el pago de los líquidos, la fecha de pago de la nómina pasa a ser
     la del pago.
   - Casillas 01 y 04: perceptores distintos por NIF. 02: bruto dinerario más
     indemnización sujeta (sin dietas ni indemnizaciones exentas). 05:
     valoración de la especie más el ingreso a cuenta no repercutido (art. 43.2
     LIRPF). 06: ingresos a cuenta.
   - Profesionales (07-09): facturas de gasto confirmadas con retención, por
     fecha de factura, como antes.
   - El resumen mensual antiguo (`NominaResumen`) solo cuenta en los meses sin
     nóminas por trabajador, con aviso de que la casilla 01 no es fiable. No
     entra en el 190.
2. **El formato canónico es el del módulo Impuestos** (casillas oficiales y
   `DatosModelo111` para el TXT). `tax-models` lo calcula con la misma función,
   guarda lo mismo en `ModeloImpuesto` y solo adapta la respuesta a su pantalla.
   No recalcula un modelo presentado, omitido o editado a mano.
3. **El 190 sale de la misma fuente**: un registro por perceptor y clave (A
   trabajo; L.01 dietas exentas; L.05 indemnización por despido exenta; G
   profesionales, subclave 03 si la retención es del 7 %). Gastos deducibles =
   SS del trabajador. Comprueba que sus retenciones coinciden con la suma de
   los cuatro 111. El detalle por perceptor solo se ve con `nominas:read`; en
   `ModeloImpuesto`, en la pantalla de modelos fiscales y en el calendario del
   módulo Impuestos (vence el 31 de enero) quedan solo totales, y el fichero no
   se descarga desde Impuestos.
4. **Fichero del 190**: el diseño de registro verificado es el del ejercicio
   2025 (Orden HAC/1431/2025). Para un ejercicio sin diseño verificado la
   exportación responde 409 con un mensaje claro y queda el informe en Excel.
   Cuando la AEAT publique el de 2026, hay que revisar las posiciones y añadir
   el año a `DISENOS_190_VERIFICADOS`.
5. **No se sincroniza `RetentionBook`** con las nóminas. Los informes que lo
   leen (retenciones por tercero) los ve cualquiera con `contabilidad:read`, y
   copiar ahí cada nómina enseñaría el IRPF de cada trabajador a ventas,
   tesorería o solo-lectura. Además serían dos fuentes otra vez.
6. **Pagos**, cada uno con su asiento cuadrado, en transacción y con el periodo
   de la fecha abierto (`comprobarFechaAbierta`):
   - Líquidos (`NOM-PAG`): 465 de cada trabajador (y la de embargos si se pagan
     a la vez) contra 572/570. Uno o todos los del mes. Las nóminas pasan a
     `PAGADA` y comparten el asiento (`asientoPagoId`).
   - Seguros sociales (`SS`, tabla `LiquidacionSS`): 476 por lo previsto en las
     nóminas, la diferencia con el RLC a la 642 y la IT compensada a la 471,
     contra 572/570.
   - 111 (`TES`, `invoiceType` `MODELO_111`): 4751 de trabajo y de
     profesionales contra 572/570.
   - Con `movimientoId` se concilia un cargo del extracto por el mismo importe:
     no se contabiliza dos veces.
   - Anular: con el periodo abierto el asiento pasa a `REVERSED`; con el
     periodo cerrado, contraasiento con la fecha de anulación (como los cobros).
7. **PDF de la gestoría** en el almacenamiento privado y en `DocumentoArchivo`
   con tipo `nomina` o `seguros_sociales` (SHA-256 contra duplicados). Solo se
   listan y descargan por `/nominas`. El archivo de facturas los excluye.

## Consecuencias

- El 111 de la pantalla, el del módulo Impuestos y su TXT dan lo mismo, y el
  TXT ya lleva las casillas 04 a 09 (antes faltaban las de profesionales y la
  28 no cuadraba con el detalle).
- `GET /tax-models/190` ya no exige haber generado antes los cuatro 111.
- Pendiente: la prestación de IT en pago delegado no tiene columna en la
  nómina (va en el bruto, a la 640). Si el RLC compensa IT, la 471 queda con
  saldo acreedor hasta que la nómina la separe. Tampoco se registran todavía
  la clave del 190 de las indemnizaciones exentas que no sean por despido, ni
  los hijos, ascendientes y reducciones del trabajador.
