/* Endpoints de nominas y trabajadores para la documentacion OpenAPI.
   Lo usa scripts/generar-swagger.js: ep(ruta, metodo, etiqueta, resumen, opciones). */
module.exports = function nominasSwagger(ep, B) {
  const T = 'Nominas';
  const E = 'Trabajadores';
  const importar = ['archivo', 'subidaId', 'filas', 'mapeo', 'filaCabecera', 'separadorDecimal', 'ejercicio', 'mes', 'brutoIncluyeEspecie'];

  ep(B + '/empleados', 'get', E, 'Trabajadores de la empresa (nominas:read)', { query: ['activos', 'q'] });
  ep(B + '/empleados', 'post', E, 'Alta de trabajador: NIF/NIE con letra de control, NAF con digitos de control (nominas:write)', {
    body: { nif: '00000000T', nombre: 'Nombre', apellidos: 'Apellidos', naf: '280000000091', fechaAlta: '2026-01-01', tipoContrato: 'INDEFINIDO' },
  });
  ep(B + '/empleados/{id}', 'get', E, 'Ficha del trabajador, con el numero de nominas');
  ep(B + '/empleados/{id}', 'put', E, 'Editar trabajador (el NIF solo si no tiene nominas)');
  ep(B + '/empleados/{id}/baja', 'post', E, 'Baja del trabajador', { body: { fechaBaja: '2026-06-30' } });
  ep(B + '/empleados/{id}', 'delete', E, 'Borrar trabajador (solo sin nominas; si tiene, baja)');

  ep(B + '/nominas', 'get', T, 'Nominas por trabajador (nominas:read)', { query: ['ejercicio', 'mes', 'empleadoId', 'estado'] });
  ep(B + '/nominas', 'post', T, 'Alta manual de una nomina en borrador; 400 si no cuadra (liquido = devengado - deducciones), 409 si ya existe', {
    body: { empleadoId: '...', ejercicio: 2026, mes: 1, tipo: 'ORDINARIA', brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 },
  });
  ep(B + '/nominas/{id}', 'get', T, 'Detalle de una nomina, con su cuadre');
  ep(B + '/nominas/{id}', 'put', T, 'Editar una nomina en borrador (409 si esta contabilizada)');
  ep(B + '/nominas/{id}', 'delete', T, 'Borrar una nomina en borrador o anulada');
  ep(B + '/nominas/plantilla', 'get', T, 'Plantilla Excel con las columnas que reconoce el importador');
  ep(B + '/nominas/resumen', 'get', T, 'Totales por mes del ejercicio (calculados con las nominas por trabajador)', { query: ['ejercicio'] });
  ep(B + '/nominas/resumen', 'post', T, 'OBSOLETO: responde 400 (usar POST /nominas/importar o POST /nominas)');
  ep(B + '/nominas/importar/subidas', 'post', T, 'Trozo de un Excel grande (campo trozo + indice, total; el primero con nombre y tamano)', {
    multipart: ['trozo', 'subidaId', 'indice', 'total', 'nombre', 'tamano', 'hash'],
  });
  ep(B + '/nominas/importar/subidas/{subidaId}', 'delete', T, 'Descartar una subida por trozos');
  ep(B + '/nominas/importar/vista-previa', 'post', T, 'Vista previa del Excel de la gestoria: cuadre por trabajador, errores, trabajadores nuevos. No guarda nada. Si no reconoce las columnas devuelve necesitaMapeo', {
    multipart: importar,
  });
  ep(B + '/nominas/importar', 'post', T, 'Confirmar la importacion (fichero o filas revisadas): alta de trabajadores nuevos y nominas en borrador; contabilizar=true las contabiliza', {
    multipart: [...importar, 'contabilizar'],
  });
  ep(B + '/nominas/periodos/{ejercicio}/{mes}', 'get', T, 'Mes de nominas: trabajadores, estado, cuadre y totales');
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/asiento-preview', 'get', T, 'Asientos del mes: los contabilizados y los que se generarian (uno por trabajador)', { query: ['nominaIds'] });
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/contabilizar', 'post', T, 'Contabilizar las nominas en borrador: un asiento NOM-xxxxx por trabajador con su subcuenta 465. 409 si ya estan contabilizadas, 400 si el periodo esta cerrado', {
    body: { nominaIds: [] },
  });
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/anular', 'post', T, 'Anular: asiento REVERSED con el periodo abierto o contraasiento con fecha de anulacion si esta cerrado; las nominas vuelven a borrador (o quedan anuladas)', {
    body: { nominaIds: [], fecha: '2026-03-01', motivo: 'Importe corregido por la gestoria', dejarAnuladas: false },
  });

  // Tesoreria: pago de los liquidos, seguros sociales y 111.
  const medio = { fecha: '2026-01-30', cuentaBancariaId: '...', caja: false, movimientoId: '...' };
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/pago', 'post', T, 'Pagar los liquidos (todas las contabilizadas del mes o nominaIds): asiento NOM-PAG con la 465 de cada trabajador contra 572/570; con movimientoId concilia un cargo del extracto por el mismo importe. Las nominas quedan PAGADAS y su fecha de pago (la del 111) es la del pago', {
    body: { ...medio, nominaIds: [], incluirEmbargos: false },
  });
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/pago/anular', 'post', T, 'Anular el pago (entero): REVERSED con el periodo abierto o contraasiento; el movimiento del banco queda sin conciliar', {
    body: { nominaIds: [], fecha: '2026-03-01', motivo: '' },
  });
  ep(B + '/nominas/seguros-sociales', 'get', T, 'Seguros sociales de los 12 meses: previsto por las nominas, RLC, diferencia y pago', { query: ['ejercicio'] });
  ep(B + '/nominas/seguros-sociales/{ejercicio}/{mes}', 'get', T, 'Seguros sociales de un mes', { query: ['tipo'] });
  ep(B + '/nominas/seguros-sociales/{ejercicio}/{mes}', 'put', T, 'Guardar el RLC real, la IT compensada o la fecha de cargo', {
    body: { tipo: 'NORMAL', totalRlc: 1936.55, compensacionIt: 0, fechaCargoPrevista: '2026-02-28', observaciones: '' },
  });
  ep(B + '/nominas/seguros-sociales/{ejercicio}/{mes}/pago', 'post', T, 'Pagar los seguros sociales: 476 (previsto) y la diferencia con el RLC a la 642, IT compensada a la 471, contra 572/570 (asiento SS)', {
    body: { ...medio, tipo: 'NORMAL', totalRlc: 1936.55, compensacionIt: 0 },
  });
  ep(B + '/nominas/seguros-sociales/{ejercicio}/{mes}/pago/anular', 'post', T, 'Anular el pago de los seguros sociales', { body: { tipo: 'NORMAL', fecha: '2026-03-01' } });
  ep(B + '/nominas/retenciones/{ejercicio}/{periodo}', 'get', T, 'Modelo 111 (1T-4T, 01-12): casillas 01-09, 28 y 30 con la misma fuente que Impuestos (nominas por fecha de pago, perceptores distintos), su pago y lo que se paga (aPagar: lo presentado o editado en Impuestos manda sobre el calculo)');
  ep(B + '/nominas/retenciones/{ejercicio}/{periodo}/pago', 'post', T, 'Pagar el 111 (lo presentado o, si no, lo calculado): 4751 de trabajo, la del IRPF del resumen antiguo y la de profesionales contra 572/570. 409 si hay nominas del periodo en borrador', {
    body: { ...medio, cuentaProfesionales: '475100', cuentaResumenAntiguo: '475100' },
  });
  ep(B + '/nominas/retenciones/{ejercicio}/{periodo}/pago/anular', 'post', T, 'Anular el pago del 111', { body: { fecha: '2026-05-01' } });
  ep(B + '/nominas/190/{ejercicio}/perceptores', 'get', T, 'Modelo 190: un registro por perceptor y clave (A trabajo, L.01 dietas, L.05 indemnizacion exenta, G profesionales), totales y cuadre con los cuatro 111. ?formato=xlsx', {
    query: ['formato'],
  });
  ep(B + '/nominas/190/{ejercicio}/fichero', 'get', T, 'Fichero del 190 (TXT AEAT, ISO-8859-1). 409 si el diseno de registro del ejercicio no esta verificado (hoy, solo el de 2025); 400 si faltan datos', {
    query: ['telefono', 'contacto', 'email', 'numeroDeclaracion'],
  });
  ep(B + '/nominas/conciliacion/sugerencias', 'get', T, 'Pagos de nominas, seguros sociales o 111 pendientes que cuadran con un cargo del extracto', { query: ['movimientoId'] });
  ep(B + '/nominas/conciliacion/cargos', 'get', T, 'Cargos del extracto sin conciliar por un importe exacto (para pagar eligiendo el cargo, que queda conciliado)', { query: ['importe', 'fecha'] });
  ep(B + '/nominas/prevision', 'get', T, 'Prevision de pagos: liquidos sin pagar, seguros sociales pendientes y 111 que vence en el rango', { query: ['desde', 'hasta'] });

  // Archivo privado de los PDF de la gestoria (solo nominas:read).
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/documentos', 'get', T, 'PDF de nominas y seguros sociales del mes');
  ep(B + '/nominas/periodos/{ejercicio}/{mes}/documentos', 'post', T, 'Subir un PDF (archivo; tipo nomina|rlc|rnt; nominaId si es el recibo de un trabajador). 409 si ya esta (SHA-256)', {
    multipart: ['archivo', 'tipo', 'nominaId', 'observaciones'],
  });
  ep(B + '/nominas/documentos', 'get', T, 'PDF de nominas del ejercicio', { query: ['ejercicio', 'trimestre', 'mes'] });
  ep(B + '/nominas/documentos/zip', 'get', T, 'ZIP de los PDF de nominas de un ejercicio, trimestre o mes', { query: ['ejercicio', 'trimestre', 'mes'] });
  ep(B + '/nominas/documentos/{documentoId}/descargar', 'get', T, 'Descargar un PDF de nominas');
  ep(B + '/nominas/documentos/{documentoId}', 'delete', T, 'Anular un PDF de nominas (sale del archivo)');

  ep(B + '/nominas/informes/coste', 'get', T, 'Coste de personal por mes o por trabajador (bruto, SS empresa, indemnizaciones, coste total). ?formato=xlsx', {
    query: ['ejercicio', 'agrupar', 'formato'],
  });
};
