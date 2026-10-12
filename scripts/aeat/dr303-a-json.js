#!/usr/bin/env node
/**
 * Convierte el diseño de registro OFICIAL del modelo 303 (AEAT, DR303e26v101.xlsx,
 * exportado hoja a hoja a texto con columnas separadas por " | ") a la tabla
 * JSON que usan el generador del fichero y su test dorado
 * (src/domain/aeat/dr303-2026.json).
 *
 * Uso: node scripts/aeat/dr303-a-json.js <carpeta con DP30300.txt...> <salida.json>
 *
 * Solo transcribe: Nº, posición, longitud, tipo, descripción, validación y
 * contenido de cada campo, la longitud total y las notas de cada hoja. Además
 * anota la casilla ([01], [27]...) que cierra la descripción y la constante
 * cuando el contenido es un único literal ("<T", Constante "01000"...).
 */
const fs = require('fs');
const path = require('path');

const HOJAS = [
  ['cabecera', 'DP30300.txt'],
  ['01', 'DP30301.txt'],
  ['02', 'DP30302.txt'],
  ['03', 'DP30303.txt'],
  ['04', 'DP30304.txt'],
  ['05', 'DP30305.txt'],
  ['DID', 'DP303DID.txt'],
];

const celdas = (linea) => linea.split('|').map((s) => s.trim());
const CONSTANTE = /^(?:Constante\s+)?"([^"]*)"\s*(?:\.?\s*Nota \d+\.?\s*)*$/;
const CASILLA = /\[([0-9A-Z]+)\]\s*$/;

function leerHoja(fichero) {
  const lineas = fs.readFileSync(fichero, 'utf8').replace(/\r/g, '').split('\n');
  const iCab = lineas.findIndex((l) => l.startsWith('Nº |'));
  if (iCab < 0) throw new Error(`${fichero}: sin fila de cabecera`);
  const cab = celdas(lineas[iCab]);
  const col = (nombre) => cab.findIndex((c) => c.startsWith(nombre));
  const iComp = col('Comp');
  const iDesc = col('Descrip');
  const iVal = col('Valid');
  const iCont = col('Conten');
  const campos = [];
  const notas = [];
  let longitud = null;
  let enNotas = false;
  for (const linea of lineas.slice(iCab + 1)) {
    const c = celdas(linea);
    if (!enNotas && /^\d+$/.test(c[0])) {
      const campo = {
        n: Number(c[0]),
        pos: c[1] === '***' ? null : Number(c[1]),
        lon: /^\d+$/.test(c[2]) ? Number(c[2]) : null,
        tipo: c[3],
        ...(iComp >= 0 && c[iComp] ? { comp: c[iComp] } : {}),
        descripcion: c[iDesc],
        validacion: c[iVal] || '',
        contenido: c[iCont] || '',
      };
      const casilla = CASILLA.exec(campo.descripcion);
      if (casilla) campo.casilla = casilla[1];
      const constante = campo.pos !== null ? CONSTANTE.exec(campo.contenido) : null;
      if (constante) campo.constante = constante[1];
      if (/^Reservado/i.test(campo.descripcion)) campo.reservado = true;
      campos.push(campo);
      continue;
    }
    if (/^total$/i.test(c[0])) {
      longitud = /^\d+$/.test(c[2]) ? Number(c[2]) : null;
      enNotas = true;
      continue;
    }
    if (enNotas) {
      const texto = c.filter(Boolean).join(' ');
      if (texto) notas.push(texto);
    }
  }
  return { longitud, campos, notas };
}

/** JSON legible y compacto: un campo por línea (los diffs se leen campo a campo). */
function aTexto(json) {
  const paginas = Object.entries(json.paginas).map(([clave, p]) => {
    const campos = p.campos.map((c) => `    ${JSON.stringify(c)}`).join(',\n');
    const notas = p.notas.map((n) => `    ${JSON.stringify(n)}`).join(',\n');
    return `  ${JSON.stringify(clave)}: {\n   "hoja": ${JSON.stringify(p.hoja)}, "longitud": ${JSON.stringify(p.longitud)},\n   "campos": [\n${campos}\n   ],\n   "notas": [\n${notas}\n   ]\n  }`;
  });
  const { paginas: _p, ...resto } = json;
  const cabecera = Object.entries(resto).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return `{\n${cabecera},\n "paginas": {\n${paginas.join(',\n')}\n }\n}\n`;
}

function main() {
  const [dir, salida] = process.argv.slice(2);
  if (!dir || !salida) {
    console.error('Uso: node scripts/aeat/dr303-a-json.js <carpeta> <salida.json>');
    process.exit(1);
  }
  const paginas = {};
  for (const [clave, fichero] of HOJAS) {
    paginas[clave] = { hoja: path.basename(fichero, '.txt'), ...leerHoja(path.join(dir, fichero)) };
  }
  const json = {
    modelo: '303',
    version: '1.01',
    ejercicios: 'Presentaciones a partir del ejercicio 2026',
    fuente: 'AEAT, diseño de registro DR303e26v101.xlsx (sede.agenciatributaria.gob.es, procedimiento G414)',
    columnas: { n: 'Nº', pos: 'Posición', lon: 'Longitud', tipo: 'Tipo', comp: 'Comp', descripcion: 'Descripción', validacion: 'Validación', contenido: 'Contenido' },
    paginas,
  };
  fs.writeFileSync(salida, aTexto(json), 'utf8');
  const resumen = Object.entries(paginas).map(([k, p]) => `${k}: ${p.campos.length} campos, ${p.longitud ?? 'variable'}`);
  console.log(resumen.join('\n'));
}

main();
