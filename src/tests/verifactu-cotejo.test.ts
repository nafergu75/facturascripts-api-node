/**
 * URL de cotejo del QR de VERI*FACTU (services/verifactu/qr.ts; documento
 * tecnico del QR v0.5.0 de la AEAT, apdos. 4 a 8) y su matriz. Ida y vuelta con
 * el lector de QR de la app (services/lectura/verifactu-qr).
 */
import { codificarComoJava, matrizQr, tramosQr, urlCotejo, type RegistroCotejo } from '../services/verifactu/qr';
import { interpretarValorQr } from '../services/lectura/verifactu-qr';
import QRCode from 'qrcode';

const OFICIAL: RegistroCotejo = { entorno: 'PRODUCCION', idEmisor: '89890001K', numSerie: '12345678-G33', fechaExpedicion: '01-09-2024', importeTotal: '241.40' };

describe('urlCotejo', () => {
  it('el ejemplo oficial (apdo. 8.3), con el importe con dos decimales', () => {
    expect(urlCotejo(OFICIAL)).toBe('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678-G33&fecha=01-09-2024&importe=241.40');
  });

  it('el host sale del entorno del registro; nunca formato ni idioma', () => {
    const pruebas = urlCotejo({ ...OFICIAL, entorno: 'PRUEBAS' });
    expect(pruebas.startsWith('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=')).toBe(true);
    for (const u of [pruebas, urlCotejo(OFICIAL)]) {
      expect(u).not.toMatch(/formato|idioma/);
      expect([...new URL(u).searchParams.keys()]).toEqual(['nif', 'numserie', 'fecha', 'importe']);
    }
    expect(() => urlCotejo({ ...OFICIAL, entorno: 'OTRO' })).toThrow();
  });

  it('codifica como el URLEncoder de Java: & en %26, espacio en +, ! \' ( ) ~ en %XX y * tal cual', () => {
    expect(urlCotejo({ ...OFICIAL, numSerie: '12345678&G33' })).toContain('numserie=12345678%26G33&');
    expect(urlCotejo({ ...OFICIAL, numSerie: 'A 1/2' })).toContain('numserie=A+1%2F2&');
    expect(codificarComoJava("!'()~*._-")).toBe('%21%27%28%29%7E*._-');
  });

  it('rechaza lo que no tiene la forma de la AEAT', () => {
    expect(() => urlCotejo({ ...OFICIAL, idEmisor: '8989' })).toThrow();
    expect(() => urlCotejo({ ...OFICIAL, numSerie: '' })).toThrow();
    expect(() => urlCotejo({ ...OFICIAL, numSerie: 'x'.repeat(61) })).toThrow();
    expect(() => urlCotejo({ ...OFICIAL, numSerie: 'Ñ-1' })).toThrow();
    expect(() => urlCotejo({ ...OFICIAL, fechaExpedicion: '2024-09-01' })).toThrow();
    expect(() => urlCotejo({ ...OFICIAL, importeTotal: '241.4' })).toThrow();
    expect(() => urlCotejo({ ...OFICIAL, importeTotal: '241,40' })).toThrow();
  });

  it('ida y vuelta con el lector de QR de la app: produccion VALIDO con los mismos datos; pruebas, PRUEBAS', () => {
    const leido = interpretarValorQr(urlCotejo({ ...OFICIAL, numSerie: 'A&B 7' }));
    expect(leido).toMatchObject({ estado: 'VALIDO', verifactu: true, datos: { nif: '89890001K', numserie: 'A&B 7', fecha: '2024-09-01', importe: 241.4 } });
    expect(interpretarValorQr(urlCotejo({ ...OFICIAL, entorno: 'PRUEBAS' }))?.estado).toBe('PRUEBAS');
  });
});

describe('matriz del QR', () => {
  const url = urlCotejo({ ...OFICIAL, entorno: 'PRUEBAS', numSerie: 'PRU261015-1', importeTotal: '121.00' });

  it('nivel de correccion M (la matriz es la de qrcode con M)', () => {
    const m = matrizQr(url);
    const conM = QRCode.create(url, { errorCorrectionLevel: 'M' });
    expect(conM.errorCorrectionLevel.bit).toBe(0); // M en la libreria (L=1, M=0, Q=3, H=2)
    expect(m.n).toBe(conM.modules.size);
    for (let f = 0; f < m.n; f++) for (let c = 0; c < m.n; c++) expect(m.oscuro(f, c)).toBe(conM.modules.get(f, c) === 1);
    expect((m.n - 17) % 4).toBe(0);
  });

  it('los tramos reconstruyen la matriz exacta', () => {
    const m = matrizQr(url);
    const rehecha = Array.from({ length: m.n }, () => Array<boolean>(m.n).fill(false));
    for (const t of tramosQr(m)) for (let c = t.col; c < t.col + t.largo; c++) rehecha[t.fila][c] = true;
    for (let f = 0; f < m.n; f++) for (let c = 0; c < m.n; c++) expect(rehecha[f][c]).toBe(m.oscuro(f, c));
    // Los patrones de posicion: la esquina de arriba a la izquierda es oscura.
    expect(m.oscuro(0, 0)).toBe(true);
  });
});
