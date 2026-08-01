import { createHash } from 'crypto';

/** SHA-256 en hexadecimal de un buffer (huella de PDF/ZIP). */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// Tabla CRC-32 (requerida por el formato ZIP).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Crea un ZIP "store" (sin compresión), válido y SIN dependencias externas.
 * Suficiente para empaquetar los PDF/A de un expediente de legalización. Si en
 * el futuro se necesita compresión, sustituir por `archiver`/`jszip` sin cambiar
 * la interfaz de los servicios que lo consumen.
 */
export function crearZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // firma cabecera local
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // flags (bit 11 = nombres UTF-8)
    local.writeUInt16LE(0, 8); // método 0 = store
    local.writeUInt16LE(0, 10); // hora
    local.writeUInt16LE(0, 12); // fecha
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // tamaño comprimido
    local.writeUInt32LE(size, 22); // tamaño sin comprimir
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // longitud extra
    localParts.push(local, name, e.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // firma directorio central
    cen.writeUInt16LE(20, 4); // versión creadora
    cen.writeUInt16LE(20, 6); // versión necesaria
    cen.writeUInt16LE(0x0800, 8); // flags
    cen.writeUInt16LE(0, 10); // método
    cen.writeUInt16LE(0, 12); // hora
    cen.writeUInt16LE(0, 14); // fecha
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(size, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comentario
    cen.writeUInt16LE(0, 34); // nº disco
    cen.writeUInt16LE(0, 36); // atributos internos
    cen.writeUInt32LE(0, 38); // atributos externos
    cen.writeUInt32LE(offset, 42); // offset de la cabecera local
    central.push(cen, name);

    offset += local.length + name.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(localParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // firma EOCD
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, end]);
}
