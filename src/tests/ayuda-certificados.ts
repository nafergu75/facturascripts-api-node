/**
 * Certificados de usar y tirar para los tests de VERI*FACTU (nunca los reales
 * del usuario): una CA, el certificado de un servidor HTTPS local y
 * certificados de cliente en PKCS#12 (AES-256, 3DES, RC2-40, caducado, aun no
 * valido, de otra CA, sin clave, con 2.000.000 de iteraciones...).
 *
 * Las claves se crean con crypto.generateKeyPairSync de Node (el generador de
 * forge es muy lento); forge solo arma y FIRMA los certificados de prueba y
 * empaqueta el PKCS#12. Nunca se usa forge para verificar firmas.
 */
import { generateKeyPairSync, randomBytes } from 'crypto';
import forge from 'node-forge';

export interface ParClaves {
  clavePem: string;
  publicaPem: string;
}

export function parRsa(): ParClaves {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { clavePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicaPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

type Atributo = { name?: string; shortName?: string; type?: string; value: string };

export interface CertificadoPrueba extends ParClaves {
  certPem: string;
  cert: forge.pki.Certificate;
}

let serie = 1;

/** Certificado firmado por `firmante` (o autofirmado si no hay). */
export function crearCertificado(o: {
  sujeto: Atributo[];
  par?: ParClaves;
  firmante?: CertificadoPrueba;
  ca?: boolean;
  desde?: Date;
  hasta?: Date;
  dns?: string[];
  ips?: string[];
}): CertificadoPrueba {
  const par = o.par ?? parRsa();
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(par.publicaPem);
  // Primer byte entre 0x40 y 0x7E: positivo y sin ceros delante (DER minimo; OpenSSL rechaza el «padding»).
  c.serialNumber = (0x40 + (serie++ % 0x3f)).toString(16) + randomBytes(7).toString('hex');
  c.validity.notBefore = o.desde ?? new Date(Date.now() - 86_400_000);
  c.validity.notAfter = o.hasta ?? new Date(Date.now() + 365 * 86_400_000);
  c.setSubject(o.sujeto);
  c.setIssuer(o.firmante ? o.firmante.cert.subject.attributes : o.sujeto);
  const ext: unknown[] = [{ name: 'basicConstraints', cA: !!o.ca }, { name: 'keyUsage', keyCertSign: !!o.ca, cRLSign: !!o.ca, digitalSignature: true, keyEncipherment: true }];
  if (!o.ca) ext.push({ name: 'extKeyUsage', serverAuth: true, clientAuth: true });
  if (o.dns?.length || o.ips?.length) {
    ext.push({ name: 'subjectAltName', altNames: [...(o.dns ?? []).map((value) => ({ type: 2, value })), ...(o.ips ?? []).map((ip) => ({ type: 7, ip }))] });
  }
  c.setExtensions(ext as never[]);
  c.sign(forge.pki.privateKeyFromPem(o.firmante?.clavePem ?? par.clavePem) as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
  return { ...par, cert: c, certPem: forge.pki.certificateToPem(c) };
}

export function crearCa(nombre = 'AC DE PRUEBAS'): CertificadoPrueba {
  return crearCertificado({ sujeto: [{ name: 'commonName', value: nombre }, { name: 'organizationName', value: 'PRUEBAS' }, { name: 'countryName', value: 'ES' }], ca: true, hasta: new Date(Date.now() + 5 * 365 * 86_400_000) });
}

/** Sujeto de un certificado de representante de persona juridica, como los de la FNMT. */
export function sujetoRepresentante(nifEmpresa: string, empresa: string, nifPersona = '12345678Z'): Atributo[] {
  return [
    { name: 'countryName', value: 'ES' },
    { name: 'organizationName', value: empresa },
    { type: '2.5.4.97', value: `VATES-${nifEmpresa}` },
    { name: 'serialNumber', value: `IDCES-${nifPersona}` },
    { name: 'commonName', value: `${nifPersona} NOMBRE APELLIDO (R: ${nifEmpresa})` },
  ];
}

export function sujetoPersona(nif = '12345678Z'): Atributo[] {
  return [
    { name: 'countryName', value: 'ES' },
    { name: 'serialNumber', value: `IDCES-${nif}` },
    { name: 'commonName', value: `APELLIDO NOMBRE - ${nif}` },
  ];
}

export function sujetoSello(nifEmpresa: string, empresa: string): Atributo[] {
  return [
    { name: 'countryName', value: 'ES' },
    { name: 'organizationName', value: empresa },
    { type: '2.5.4.97', value: `VATES-${nifEmpresa}` },
    { name: 'commonName', value: `SELLO ${empresa}` },
  ];
}

/** PKCS#12 con la clave cifrada (AES-256 o 3DES) y la cadena. */
export function pkcs12(o: {
  cert?: CertificadoPrueba;
  cadena?: CertificadoPrueba[];
  contrasena: string;
  algoritmo?: 'aes256' | '3des';
  sinClave?: boolean;
  sinLocalKeyId?: boolean;
  iteraciones?: number;
}): Buffer {
  const certs = [...(o.cert ? [o.cert.cert] : []), ...(o.cadena ?? []).map((c) => c.cert)];
  const clave = o.sinClave || !o.cert ? null : forge.pki.privateKeyFromPem(o.cert.clavePem);
  const restaurar = pbkdf2Nativo();
  try {
    const asn1 = forge.pkcs12.toPkcs12Asn1(clave, certs, o.contrasena, {
      algorithm: o.algoritmo ?? 'aes256',
      count: o.iteraciones ?? 2048,
      generateLocalKeyId: !o.sinLocalKeyId,
      friendlyName: 'certificado de prueba',
    });
    return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
  } finally {
    restaurar();
  }
}

/**
 * Mientras se arma un PKCS#12 de prueba: PBES2 (AES) con la contraseña en
 * UTF-8, como OpenSSL y Windows (forge usaria el byte bajo de cada caracter),
 * y con el PBKDF2 nativo de Node (el de forge tarda segundos con un millon de
 * iteraciones). Devuelve la funcion que lo deja como estaba.
 */
function pbkdf2Nativo(): () => void {
  const p5 = forge.pkcs5 as unknown as { pbkdf2: (...a: unknown[]) => unknown };
  const original = p5.pbkdf2;
  p5.pbkdf2 = (c: unknown, s: unknown, n: unknown, largo: unknown, md: unknown, ...resto: unknown[]) => {
    const nombre = md && typeof md === 'object' ? (md as { algorithm?: string }).algorithm : md;
    return original(typeof c === 'string' ? forge.util.encodeUtf8(c) : c, s, n, largo, nombre, ...resto);
  };
  return () => {
    p5.pbkdf2 = original;
  };
}

/**
 * PKCS#12 armado a mano para probar los topes de trabajo: el certificado en
 * claro y cada clave en su pkcs8ShroudedKeyBag (PBES2 AES-256), a la vista o
 * ESCONDIDA dentro de una parte cifrada (EncryptedData, PBES2 con 2.048
 * iteraciones), que solo se ve al descifrarla. `iteracionesFalsas` cambia
 * despues el numero de iteraciones de esa clave sin recalcular nada (el tope
 * tiene que saltar antes de usarlo). MAC SHA-1 con 2.048 iteraciones.
 */
export function pkcs12AMedida(o: {
  cert: CertificadoPrueba;
  contrasena: string;
  claves: Array<{ iteraciones?: number; iteracionesFalsas?: number; escondida?: boolean }>;
}): Buffer {
  const { asn1, pki, pkcs12: p12, util, md, hmac, random } = forge;
  const U = asn1.Class.UNIVERSAL;
  const CTX = asn1.Class.CONTEXT_SPECIFIC;
  const seq = (v: forge.asn1.Asn1[]) => asn1.create(U, asn1.Type.SEQUENCE, true, v);
  const oid = (x: string) => asn1.create(U, asn1.Type.OID, false, asn1.oidToDer(x).getBytes());
  const oct = (b: string) => asn1.create(U, asn1.Type.OCTETSTRING, false, b);
  const int = (n: number) => asn1.create(U, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
  const exp0 = (v: forge.asn1.Asn1[]) => asn1.create(CTX, 0, true, v);
  const hijos = (n: forge.asn1.Asn1) => n.value as forge.asn1.Asn1[];
  const restaurar = pbkdf2Nativo();
  try {
    const certBag = seq([oid(pki.oids.certBag), exp0([seq([oid(pki.oids.x509Certificate), exp0([oct(asn1.toDer(pki.certificateToAsn1(o.cert.cert)).getBytes())])])])]);
    const infoClave = pki.wrapRsaPrivateKey(pki.privateKeyToAsn1(pki.privateKeyFromPem(o.cert.clavePem) as forge.pki.rsa.PrivateKey));
    const bolsa = (c: (typeof o.claves)[number]) => {
      const cifrada = pki.encryptPrivateKeyInfo(infoClave, o.contrasena, { algorithm: 'aes256', count: c.iteraciones ?? 2048, prfAlgorithm: 'sha256' } as never);
      if (c.iteracionesFalsas) {
        // EncryptedPrivateKeyInfo > AlgorithmIdentifier(PBES2) > parametros > PBKDF2 > parametros > iteraciones.
        hijos(hijos(hijos(hijos(hijos(cifrada)[0])[1])[0])[1])[1] = int(c.iteracionesFalsas);
      }
      return seq([oid(pki.oids.pkcs8ShroudedKeyBag), exp0([cifrada])]);
    };
    const aLaVista = o.claves.filter((c) => !c.escondida).map(bolsa);
    const escondidas = o.claves.filter((c) => c.escondida).map(bolsa);
    const partes: forge.asn1.Asn1[] = [seq([oid(pki.oids.data), exp0([oct(asn1.toDer(seq([certBag, ...aLaVista])).getBytes())])])];
    if (escondidas.length) {
      // encryptPrivateKeyInfo cifra el DER de lo que se le pase: aqui, la SafeContents con las claves escondidas.
      const cifrado = pki.encryptPrivateKeyInfo(seq(escondidas), o.contrasena, { algorithm: 'aes256', count: 2048, prfAlgorithm: 'sha256' } as never);
      const [algoritmo, datos] = hijos(cifrado);
      const contenido = seq([oid(pki.oids.data), algoritmo, asn1.create(CTX, 0, false, datos.value as string)]);
      partes.push(seq([oid(pki.oids.encryptedData), exp0([seq([int(0), contenido])])]));
    }
    const seguro = asn1.toDer(seq(partes)).getBytes();
    const salMac = random.getBytesSync(8);
    const claveMac = p12.generateKey(o.contrasena, util.createBuffer(salMac), 3, 2048, 20);
    const mac = hmac.create();
    mac.start(md.sha1.create(), claveMac);
    mac.update(seguro);
    const macData = seq([seq([seq([oid(pki.oids.sha1), asn1.create(U, asn1.Type.NULL, false, '')]), oct(mac.getMac().getBytes())]), oct(salMac), int(2048)]);
    const pfx = seq([int(3), seq([oid(pki.oids.data), exp0([oct(seguro)])]), macData]);
    return Buffer.from(asn1.toDer(pfx).getBytes(), 'binary');
  } finally {
    restaurar();
  }
}

/** El mismo PKCS#12 con las iteraciones del MAC cambiadas a `n` (sin recalcular nada: el tope salta antes). */
export function conIteracionesMac(pfx: Buffer, n: number): Buffer {
  const asn1 = forge.asn1.fromDer(pfx.toString('binary'));
  const macData = (asn1.value as forge.asn1.Asn1[])[2];
  (macData.value as forge.asn1.Asn1[])[2] = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, forge.asn1.integerToDer(n).getBytes());
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/**
 * PKCS#12 «antiguo»: el certificado cifrado con pbeWithSHAAnd40BitRC2-CBC (lo
 * que exportaba Windows antes) y la clave con 3DES, con su MAC SHA-1. OpenSSL 3
 * (Node) no lo abre sin el proveedor «legacy».
 */
export function pkcs12Rc2(cert: CertificadoPrueba, contrasena: string): Buffer {
  const { asn1, pki, pkcs12: p12, util, rc2, md, hmac, random } = forge;
  const U = asn1.Class.UNIVERSAL;
  const CTX = asn1.Class.CONTEXT_SPECIFIC;
  const seq = (v: forge.asn1.Asn1[]) => asn1.create(U, asn1.Type.SEQUENCE, true, v);
  const oid = (o: string) => asn1.create(U, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());
  const oct = (b: string) => asn1.create(U, asn1.Type.OCTETSTRING, false, b);
  const int = (n: number) => asn1.create(U, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
  const exp0 = (v: forge.asn1.Asn1[]) => asn1.create(CTX, 0, true, v);
  const iter = 2048;

  const certBag = seq([oid(pki.oids.certBag), exp0([seq([oid(pki.oids.x509Certificate), exp0([oct(asn1.toDer(pki.certificateToAsn1(cert.cert)).getBytes())])])])]);
  const certSafe = asn1.toDer(seq([certBag])).getBytes();
  const sal = random.getBytesSync(8);
  const k = p12.generateKey(contrasena, util.createBuffer(sal), 1, iter, 5);
  const iv = p12.generateKey(contrasena, util.createBuffer(sal), 2, iter, 8);
  const cifra = rc2.createEncryptionCipher(k, 40);
  cifra.start(iv);
  cifra.update(util.createBuffer(certSafe));
  cifra.finish();
  const cifrado = cifra.output.getBytes();
  const encryptedCI = seq([
    oid(pki.oids.encryptedData),
    exp0([seq([int(0), seq([oid(pki.oids.data), seq([oid(pki.oids['pbewithSHAAnd40BitRC2-CBC']), seq([oct(sal), int(iter)])]), asn1.create(CTX, 0, false, cifrado)])])]),
  ]);

  const infoClave = pki.wrapRsaPrivateKey(pki.privateKeyToAsn1(pki.privateKeyFromPem(cert.clavePem) as forge.pki.rsa.PrivateKey));
  const claveCifrada = pki.encryptPrivateKeyInfo(infoClave, contrasena, { algorithm: '3des', count: iter });
  const keyBag = seq([oid(pki.oids.pkcs8ShroudedKeyBag), exp0([claveCifrada])]);
  const keyCI = seq([oid(pki.oids.data), exp0([oct(asn1.toDer(seq([keyBag])).getBytes())])]);

  const safe = asn1.toDer(seq([encryptedCI, keyCI])).getBytes();
  const salMac = random.getBytesSync(8);
  const claveMac = p12.generateKey(contrasena, util.createBuffer(salMac), 3, iter, 20);
  const mac = hmac.create();
  mac.start(md.sha1.create(), claveMac);
  mac.update(safe);
  const macData = seq([seq([seq([oid(pki.oids.sha1), asn1.create(U, asn1.Type.NULL, false, '')]), oct(mac.getMac().getBytes())]), oct(salMac), int(iter)]);
  const pfx = seq([int(3), seq([oid(pki.oids.data), exp0([oct(safe)])]), macData]);
  return Buffer.from(asn1.toDer(pfx).getBytes(), 'binary');
}
