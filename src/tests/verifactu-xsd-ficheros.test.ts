/**
 * Los esquemas de la AEAT de src/services/verifactu/xsd son los originales:
 * su SHA-256 es el del README. SuministroInformacion.xsd solo cambia en el
 * schemaLocation del import de xmldsig (copia local): deshecho ese cambio en
 * memoria, su huella es la del original.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DIR_XSD } from './ayuda-xsd';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const leer = (f: string) => readFileSync(join(DIR_XSD, f));

const ORIGINALES: Record<string, string> = {
  'ConsultaLR.xsd': 'bf2cdb8fc4b95b291757a72b76d8fffca06a6d30d9329122ca2fd6b2d5f8f1b1',
  'RespuestaConsultaLR.xsd': 'de35063acb8d9ba0d6ae51acc6b595de9c2b12333250e95e13108ef5f2670d45',
  'RespuestaSuministro.xsd': '82acf80f785643caac13087aae66808ed721a13f08ca5218cf8ae81b695549ef',
  'SistemaFacturacion.wsdl': '05919120708ff7650612fa6683c9336eaf919335d9a4db10e86759190af48602',
  'SuministroLR.xsd': '26bacfc6229d1a314758753244219ba207b2dcc8e2a22f7ab60b8ab6bae877e1',
  'xmldsig-core-schema.xsd': 'd102ad3df7664c307e0c2c776ba4a90513b1969974d8a940bae1a77f9f21e15d',
};
const SUMINISTRO_INFORMACION_ORIGINAL = 'ee4c1655175644de44c4c25055ffeb8e5f4bb4bc3834ce8254d4222ef18c8aa1';

describe('esquemas de la AEAT guardados en el repositorio', () => {
  it.each(Object.entries(ORIGINALES))('%s es el original', (fichero, huella) => {
    expect(sha256(leer(fichero))).toBe(huella);
  });

  it('SuministroInformacion.xsd solo cambia el schemaLocation de xmldsig', () => {
    const local = leer('SuministroInformacion.xsd').toString('utf8');
    expect(local).toContain('schemaLocation="xmldsig-core-schema.xsd"');
    expect(local).not.toContain('http://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd');
    const original = local.replace('schemaLocation="xmldsig-core-schema.xsd"', 'schemaLocation="http://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd"');
    expect(sha256(Buffer.from(original, 'utf8'))).toBe(SUMINISTRO_INFORMACION_ORIGINAL);
  });

  it('el README tiene las mismas huellas', () => {
    const readme = leer('README.md').toString('utf8');
    for (const h of [...Object.values(ORIGINALES), SUMINISTRO_INFORMACION_ORIGINAL]) expect(readme).toContain(h);
  });
});
