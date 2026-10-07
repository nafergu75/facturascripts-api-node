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
     la del pago, con dos excepciones para no declarar dos veces el mismo IRPF:
     si eso la saca de un trimestre cuyo 111 ya está presentado o pagado, se
     mantiene la fecha y se avisa (hay que corregir con una complementaria); si
     la mete en uno, 409. Al anular el pago vuelve a la fecha de antes
     (`Nomina.fechaPagoAnterior`), con la misma regla. Editar la fecha de pago
     de un borrador entre trimestres con el 111 presentado también da 409.
   - Casillas 01 y 04: perceptores distintos por NIF. 02: bruto dinerario más
     indemnización sujeta (sin dietas ni indemnizaciones exentas). 05: solo la
     valoración de la especie, como el campo de valoración del 190 (antes
     sumaba el ingreso a cuenta no repercutido y los cuatro 111 no cuadraban
     con el 190). 06: ingresos a cuenta.
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
   los cuatro 111: con lo PRESENTADO (casillas guardadas) en los trimestres
   presentados y con el cálculo en los demás (si se recalculara todo, siempre
   coincidiría). El desglose por trimestres que enseñan las pantallas sale de
   la misma fuente que sus totales (sin el resumen antiguo). Los atrasos de
   otro año llevan su ejercicio de devengo (columna del Excel y campo de la
   nómina) y van en un registro aparte. El detalle por perceptor solo se ve
   con `nominas:read`; en
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
   - 111 (`TES`, `invoiceType` `MODELO_111`): 4751 de trabajo, la del IRPF
     del resumen antiguo y la de profesionales contra 572/570. Se paga lo
     presentado (o editado a mano en Impuestos) y, si no, el cálculo. No se paga
     con nóminas del periodo en borrador (su IRPF no está en la 4751).
   - Seguros sociales complementarios: si el RLC normal ya está pagado, la SS de
     las nóminas contabilizadas después (un trabajador que llegó tarde) sale de
     la 476, no de la 642. No se anula una nómina cuya SS ya cubre un pago.
   - Con `movimientoId` se concilia un cargo del extracto por el mismo importe:
     no se contabiliza dos veces.
   - Anular: con el periodo abierto el asiento pasa a `REVERSED`; con el
     periodo cerrado, contraasiento con la fecha de anulación (como los cobros).
7. **PDF de la gestoría** en el almacenamiento privado y en `DocumentoArchivo`
   con tipo `nomina` o `seguros_sociales` (SHA-256 contra duplicados). Solo se
   listan y descargan por `/nominas`. El archivo de facturas los excluye.
   Borrar un PDF (o sustituirlo por otro recibo) lo borra del almacenamiento y
   ya no se descarga; la fila queda como anulada o reemplazada.
8. **La contabilidad no lleva el nombre ni el NIF de los trabajadores.** El
   diario, el mayor, el sumas y saldos y el plan de cuentas los ve cualquiera
   con `contabilidad:read` (ventas, tesorería, solo-lectura), que no tiene
   `nominas:read`. Los asientos se describen por la subcuenta 465 del
   trabajador ("Nómina 05/2026 - trabajador 4650001") y la subcuenta se llama
   "Remuneraciones pendientes - trabajador 4650001". Quién es cada subcuenta se
   ve en Nóminas > Empleados. Los importes por subcuenta siguen en el diario
   (son seudónimos, no anónimos): quitarlos exigiría agrupar las nóminas en un
   asiento por mes.
9. **Despliegue**: el 111 y el 190 de todas las empresas leen las tablas
   `Nomina` y `Empleado`. Antes de subir el código hay que aplicar el esquema
   en producción (`scripts/aplicar-esquema-prod.sh`, `prisma db push`). Si no
   se ha hecho, el 111 y el 190 siguen funcionando sin nóminas y con un aviso
   (se captura P2021/P2022) en lugar de responder 500.

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
