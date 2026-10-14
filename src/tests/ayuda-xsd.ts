/**
 * Validacion de XML contra los esquemas de VERI*FACTU (src/services/verifactu/xsd)
 * con xmllint-wasm, para los tests. Los esquemas se leen una vez por fichero de
 * test y se cargan en memoria (preload): xmllint no sale a internet.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { validateXML } from 'xmllint-wasm';

export const DIR_XSD = join(__dirname, '..', 'services', 'verifactu', 'xsd');

const ESQUEMAS = readdirSync(DIR_XSD)
  .filter((f) => f.endsWith('.xsd'))
  .map((f) => ({ fileName: f, contents: readFileSync(join(DIR_XSD, f), 'utf8') }));

export type EsquemaVerifactu = 'SuministroInformacion.xsd' | 'SuministroLR.xsd' | 'ConsultaLR.xsd' | 'RespuestaConsultaLR.xsd' | 'RespuestaSuministro.xsd';

/** Valida `xml` contra el esquema; los errores, con el mensaje de xmllint. */
export async function validarXsd(xml: string, esquema: EsquemaVerifactu): Promise<{ valido: boolean; errores: string[] }> {
  const principal = ESQUEMAS.find((x) => x.fileName === esquema);
  if (!principal) throw new Error(`No está el esquema ${esquema}`);
  const r = await validateXML({
    xml: [{ fileName: 'documento.xml', contents: xml }],
    schema: [principal],
    preload: ESQUEMAS.filter((x) => x.fileName !== esquema),
  });
  return { valido: r.valid, errores: r.errors.map((e) => e.rawMessage || e.message) };
}
