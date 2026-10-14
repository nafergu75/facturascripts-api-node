/**
 * Bloque SistemaInformatico de cada registro (services/verifactu/sistema.ts):
 * productor confirmado por el usuario el 14-10-2026 y version 0.1.0 hasta la
 * declaracion responsable (fase F5).
 */
import { ID_SISTEMA, NIF_PRODUCTOR, NOMBRE_PRODUCTOR, NOMBRE_SISTEMA, sistemaInformatico, VERSION_SIF } from '../services/verifactu/sistema';

describe('SistemaInformatico', () => {
  it('productor IFBIOSOLUCIONES, S.A. (A10952364), Conta API, CA, 0.1.0', () => {
    expect([NOMBRE_PRODUCTOR, NIF_PRODUCTOR, NOMBRE_SISTEMA, ID_SISTEMA, VERSION_SIF]).toEqual(['IFBIOSOLUCIONES, S.A.', 'A10952364', 'Conta API', 'CA', '0.1.0']);
  });

  it('solo VERI*FACTU y multiempresa siempre; varios obligados segun haya mas de una facturacion', () => {
    expect(sistemaInformatico({ numeroInstalacion: 'CONTA-x-20270101000000', multiplesOT: true })).toEqual({
      nombreRazon: 'IFBIOSOLUCIONES, S.A.',
      nif: 'A10952364',
      nombreSistemaInformatico: 'Conta API',
      idSistemaInformatico: 'CA',
      version: '0.1.0',
      numeroInstalacion: 'CONTA-x-20270101000000',
      tipoUsoPosibleSoloVerifactu: 'S',
      tipoUsoPosibleMultiOT: 'S',
      indicadorMultiplesOT: 'S',
    });
    expect(sistemaInformatico({ numeroInstalacion: 'x', multiplesOT: false })).toMatchObject({ tipoUsoPosibleMultiOT: 'S', indicadorMultiplesOT: 'N' });
  });
});
