import { addMonths, calcularPlazos, puedeTransicionarCuentas, puedeTransicionarPaquete } from '../domain/registroMercantil.model';
import { crearZip, sha256 } from '../utils/zip';

describe('Registro Mercantil — plazos legales', () => {
  it('legalización = cierre + 4 meses; depósito = cierre + 7 meses (cierre 31/12)', () => {
    const p = calcularPlazos('2026-12-31');
    expect(p.legalizationDeadline).toBe('2027-04-30'); // abril no tiene 31 -> recorte
    expect(p.accountsDepositDeadline).toBe('2027-07-31');
  });

  it('addMonths recorta a fin de mes y cruza año', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'); // 2026 no bisiesto
    expect(addMonths('2026-11-30', 4)).toBe('2027-03-30');
    expect(addMonths('2026-06-15', 4)).toBe('2026-10-15');
  });
});

describe('Registro Mercantil — ZIP y hash', () => {
  it('crearZip produce un ZIP válido (firma PK) y sha256 estable', () => {
    const zip = crearZip([
      { name: 'libro-DIARIO.pdf', data: Buffer.from('contenido A') },
      { name: 'libro-ACTAS.pdf', data: Buffer.from('contenido B') },
    ]);
    // Firma local file header: 'PK\x03\x04'
    expect(zip.slice(0, 4).toString('hex')).toBe('504b0304');
    // EOCD al final: 'PK\x05\x06'
    expect(zip.includes(Buffer.from('504b0506', 'hex'))).toBe(true);
    // El hash es determinista para el mismo contenido.
    expect(sha256(zip)).toBe(sha256(crearZip([
      { name: 'libro-DIARIO.pdf', data: Buffer.from('contenido A') },
      { name: 'libro-ACTAS.pdf', data: Buffer.from('contenido B') },
    ])));
    // sha256 hex de 64 chars.
    expect(sha256(zip)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Registro Mercantil — máquinas de estado', () => {
  it('expediente: CREATED->FILED->ACCEPTED válido; saltos no', () => {
    expect(puedeTransicionarPaquete('CREATED', 'FILED')).toBe(true);
    expect(puedeTransicionarPaquete('FILED', 'ACCEPTED')).toBe(true);
    expect(puedeTransicionarPaquete('CREATED', 'ACCEPTED')).toBe(false);
    expect(puedeTransicionarPaquete('ACCEPTED', 'FILED')).toBe(false);
  });

  it('cuentas: READY->FILED->APROBADO; DEFECTOS permite re-presentar', () => {
    expect(puedeTransicionarCuentas('READY', 'FILED')).toBe(true);
    expect(puedeTransicionarCuentas('FILED', 'APROBADO')).toBe(true);
    expect(puedeTransicionarCuentas('DEFECTOS', 'FILED')).toBe(true);
    expect(puedeTransicionarCuentas('DRAFT', 'FILED')).toBe(false);
  });
});
