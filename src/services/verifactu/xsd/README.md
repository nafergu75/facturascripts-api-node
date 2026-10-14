# Esquemas de VERI*FACTU (AEAT, tikeV1.0)

Copias de los esquemas oficiales de los servicios web de VERI*FACTU. Solo los
usan los tests (`src/tests/verifactu-xml.test.ts` y
`verifactu-xsd-ficheros.test.ts`) para validar el XML que genera la app con
xmllint-wasm. `tsc` no los copia a `dist`: no van al despliegue.

## Origen

- WSDL y XSD de la AEAT:
  `https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/`
  (el WSDL de pruebas está en la misma ruta de `https://prewww2.aeat.es`).
- `xmldsig-core-schema.xsd`: esquema de firma XML del W3C,
  `http://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd`.
- Descargados el 14-10-2026, con permiso del usuario.

Ojo: aunque los ficheros están en `tikeV1.0`, los espacios de nombres son
`.../aeat/tike/cont/ws/...` (sin `V1.0`), y son los de `www2` también en el
entorno de pruebas.

## Único cambio respecto al original

En `SuministroInformacion.xsd`, línea 3, el `schemaLocation` del import de
xmldsig apuntaba a la web del W3C:

    schemaLocation="http://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd"

y aquí apunta a la copia local:

    schemaLocation="xmldsig-core-schema.xsd"

Así la validación no sale a internet. El resto de ficheros están tal cual.

## SHA-256 de los originales

| Fichero | SHA-256 |
|---|---|
| ConsultaLR.xsd | bf2cdb8fc4b95b291757a72b76d8fffca06a6d30d9329122ca2fd6b2d5f8f1b1 |
| RespuestaConsultaLR.xsd | de35063acb8d9ba0d6ae51acc6b595de9c2b12333250e95e13108ef5f2670d45 |
| RespuestaSuministro.xsd | 82acf80f785643caac13087aae66808ed721a13f08ca5218cf8ae81b695549ef |
| SistemaFacturacion.wsdl | 05919120708ff7650612fa6683c9336eaf919335d9a4db10e86759190af48602 |
| SuministroInformacion.xsd | ee4c1655175644de44c4c25055ffeb8e5f4bb4bc3834ce8254d4222ef18c8aa1 (el original, antes del cambio) |
| SuministroLR.xsd | 26bacfc6229d1a314758753244219ba207b2dcc8e2a22f7ab60b8ab6bae877e1 |
| xmldsig-core-schema.xsd | d102ad3df7664c307e0c2c776ba4a90513b1969974d8a940bae1a77f9f21e15d |

`verifactu-xsd-ficheros.test.ts` comprueba estas huellas (en
`SuministroInformacion.xsd`, deshaciendo antes el cambio en memoria). Tres
ficheros tienen fin de línea CRLF: `.gitattributes` los marca `-text` para que
git no los toque.

Si la AEAT publica una versión nueva, se descargan otra vez, se repite el
único cambio y se actualiza esta tabla.
