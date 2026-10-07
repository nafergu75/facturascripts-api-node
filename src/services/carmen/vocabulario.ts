/**
 * Palabras del dominio contra las que se corrigen las faltas de escritura
 * («deve» → «debe», «factira» → «factura»). Solo se corrige hacia estas
 * palabras: una palabra desconocida y sin parecido se deja tal cual, porque
 * puede ser el nombre de un cliente o de un proveedor.
 *
 * Van sin tildes y en minúsculas. Las intenciones y las fichas añaden las suyas
 * al arrancar (ver registrarVocabulario).
 */
const BASE = `
a al algo algun alguna alguno anterior antes ahora aqui asi aun ayer año años
como con cual cuales cuando cuanto cuanta cuantos cuantas cuenta cuentas
de del desde donde dos el ella ellos en entre es esa ese eso esta este esto estos estas
ha han hay hasta hoy la las le les lo los mas me mi mis mucho muy no nos o para pero
por porque que quien quienes se si sin sobre solo su sus tambien tengo tiene tienen todo todos
tu tus un una uno unos unas va vamos ver y ya yo

abono abonos acreedor acreedores actividad adeuda alquiler alquileres amortizacion amortizaciones
anual anuales aplazamiento aplazamientos aprobar aprobado aprobados apunte apuntes
asesor asesoria asiento asientos atrasado atrasados atrasadas autonomo autonomos
balance banco bancos bancaria bancarias bancario base beneficio beneficios borrador borradores buscar busca
caducado caducados caja calendario cambiar cargo cargos categoria categorias cierre cifra cifras
cliente clientes cobrado cobrados cobrar cobro cobros comision comisiones compra compras
conciliacion conciliar conciliado configuracion contabilidad contabilizar contabilizado contable
cuota cuotas
datos debe deben deber debo declaracion declaraciones deducir deducible deducibles deuda deudas deudores
devolver devolucion diario dias dinero documento documentos
ejercicio ejercicios emitida emitidas empresa empresas entrado entradas enero febrero marzo abril mayo junio
julio agosto septiembre setiembre octubre noviembre diciembre estado extracto extractos
factura facturas facturado facturada facturadas facturar facturacion fecha fechas fiscal fiscales
gana gano ganado ganancia ganancias gasto gastos gastado gestion gestoria
hacienda historial
importe importes impuesto impuestos informe informes ingreso ingresos ingresado iva irpf
liquidez libro libros
mayor mensual mes meses modelo modelos moroso morosos movimiento movimientos
nomina nominas numero
obligaciones operacion operaciones
pagado pagados pagadas pagar pago pagos pasado pasada pendiente pendientes perdidas periodo periodos
plazo plazos presentar presentado presentacion primer primero producto productos proforma proformas
proveedor proveedores proximo proximos proxima proximas publicidad
recargo recibida recibidas rectificativa rectificativas repercutido resultado resumen retencion retenciones
retraso revisar
saldo saldos salido segundo seguridad social seguro seguros semana semestre serie series
sociedades soportado suministros
cuarto tercer tercero terceros tesoreria tipo tipos total totales trimestral trimestre trimestres
vence vencen vencida vencidas vencido vencidos vencimiento vencimientos venta ventas
`;

/** Formas verbales que se escriben sin tilde (facturé → facture). */
const VERBOS = 'facture facturamos cobre cobramos pague pagamos gaste gastamos vendi vendimos compre compramos debemos deben';

/** Palabras corrientes que no se deben «corregir» hacia una del dominio («sabes» no es «saber»). */
const COMUNES = `
sabes sabe saber puedo puedes puede pueden haces hacer hace hago eres soy estoy estas esta tienes tiene tengo quiero quieres
necesito necesitas dime dame muestrame ensename pasame busca buscar encuentra hay habia son seria sera debo debes debe
voy van vamos ir ver mira miro veo salgo sale salen sales lleva llevo llevas falta faltan queda quedan
bien mal mejor peor nuevo nueva nuevos nuevas grande pequeño mucho poco mas menos casi siempre nunca tambien
dia dias semana semanas mes meses año años hora horas hoy ayer mañana tarde noche
`;

const VOCABULARIO = new Set<string>(`${BASE} ${VERBOS} ${COMUNES}`.split(/\s+/).filter(Boolean));

/** Añade palabras al vocabulario (ya normalizadas: minúsculas y sin tildes). */
export function registrarVocabulario(palabras: Iterable<string>): void {
  for (const p of palabras) {
    if (/^[a-zñ]{2,}$/.test(p)) VOCABULARIO.add(p);
  }
}

export function esPalabraDelDominio(palabra: string): boolean {
  return VOCABULARIO.has(palabra);
}

export function vocabulario(): ReadonlySet<string> {
  return VOCABULARIO;
}

/**
 * Palabras vacías: no cuentan para la FAQ ni para buscar nombres de terceros.
 * También entran en el vocabulario (para no «corregir» «buenos» a «unos»).
 */
export const PALABRAS_VACIAS: ReadonlySet<string> = new Set(
  `a al algo algun alguna alguno ante como con contra cual cuales cuando de del desde donde
  durante e el ella ellas ellos en entre era es esa esas ese eso esos esta estas este esto estos
  fue ha han has hay he hemos la las le les lo los me mi mis muy nos o os para pero por porque
  puedo puede que quien se segun ser si sin sobre su sus te ti tu tus un una unas uno unos y ya yo
  hola buenas buenos dias tardes noches gracias favor carmen dime dame quiero quisiera saber necesito
  podrias puedes ayudame mira oye hacer hago hace ver veo miro mirar consulto consultar tengo tiene tienen tenemos esta estan estoy va vamos
  cuanto cuanta cuantos cuantas mucho poco todo todos toda todas otro otra otros otras mas menos aqui ahi alli
  hoy ayer ahora ya aun tambien solo`
    .split(/\s+/)
    .filter(Boolean),
);

registrarVocabulario(PALABRAS_VACIAS);
