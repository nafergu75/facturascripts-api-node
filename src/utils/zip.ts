import { createHash } from 'crypto';
import { deflateRawSync } from 'zlib';

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

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface OpcionesZip {
  /**
   * true: comprime cada fichero con deflate (zlib.deflateRawSync). Si el
   * resultado no ocupa menos (PDF ya comprimidos, JPG...), se guarda sin
   * comprimir. Por defecto false: ZIP "store", como hasta ahora.
   */
  comprimir?: boolean;
  /** Fecha de modificacion que se graba en cada entrada (por defecto, ninguna). */
  fecha?: Date;
}

/** Fecha y hora en el formato MS-DOS que usa el ZIP (resolucion de 2 s). */
function fechaDos(d: Date): { hora: number; fecha: number } {
  const anio = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    fecha: ((anio - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Crea un ZIP valido SIN dependencias externas. Nombres en UTF-8 (bit 11 de
 * los flags), CRC-32 propio y, opcionalmente, compresion deflate de zlib.
 * Sirve para los expedientes de legalizacion (store) y para el archivo de
 * facturas por trimestre (deflate).
 */
export function crearZip(entries: ZipEntry[], opciones: OpcionesZip = {}): Buffer {
  const localParts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // Sin fecha se graba 0: el ZIP sale identico byte a byte (hash estable).
  const { hora, fecha } = opciones.fecha ? fechaDos(opciones.fecha) : { hora: 0, fecha: 0 };

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;

    let metodo = 0; // 0 = store
    let datos = e.data;
    if (opciones.comprimir && size > 0) {
      const comprimido = deflateRawSync(e.data, { level: 9 });
      if (comprimido.length < size) {
        metodo = 8; // 8 = deflate
        datos = comprimido;
      }
    }
    const version = metodo === 8 ? 20 : 10;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // firma cabecera local
    local.writeUInt16LE(version, 4); // version necesaria
    local.writeUInt16LE(0x0800, 6); // flags (bit 11 = nombres UTF-8)
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(fecha, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(datos.length, 18); // tamano comprimido
    local.writeUInt32LE(size, 22); // tamano sin comprimir
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // longitud extra
    localParts.push(local, name, datos);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // firma directorio central
    cen.writeUInt16LE(20, 4); // version creadora
    cen.writeUInt16LE(version, 6); // version necesaria
    cen.writeUInt16LE(0x0800, 8); // flags
    cen.writeUInt16LE(metodo, 10);
    cen.writeUInt16LE(hora, 12);
    cen.writeUInt16LE(fecha, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(datos.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comentario
    cen.writeUInt16LE(0, 34); // n.º disco
    cen.writeUInt16LE(0, 36); // atributos internos
    cen.writeUInt32LE(0, 38); // atributos externos
    cen.writeUInt32LE(offset, 42); // offset de la cabecera local
    central.push(cen, name);

    offset += local.length + name.length + datos.length;
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
