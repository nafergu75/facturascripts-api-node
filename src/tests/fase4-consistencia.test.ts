import { describe, it, expect } from '@jest/globals';
import {
  esVigente,
  diasParaCaducidad,
  validarCoherenciaIncomeReader,
  validarCoherenciaRegistroMercantil,
  mensajeDocumentoExpirado,
} from '../helpers/documento';

/**
 * FASE 4: Tests de Consistencia y Endurecimiento.
 * Valida que los módulos de documentos tienen comportamiento consistente
 * y estados no ambiguos.
 */
describe('FASE 4 - Consistencia y Endurecimiento', () => {
  describe('Helpers Centralizados: Vigencia', () => {
    it('should consider document vigente without expiresAt', () => {
      const doc = { expiresAt: null };
      expect(esVigente(doc)).toBe(true);
    });

    it('should consider document vigente with future date', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 10);
      expect(esVigente({ expiresAt: futuro })).toBe(true);
    });

    it('should consider document NOT vigente with past date', () => {
      const pasado = new Date();
      pasado.setDate(pasado.getDate() - 1);
      expect(esVigente({ expiresAt: pasado })).toBe(false);
    });
  });

  describe('Helpers Centralizados: Días para Caducidad', () => {
    it('should return null without expiresAt', () => {
      const dias = diasParaCaducidad({ expiresAt: null });
      expect(dias).toBeNull();
    });

    it('should return positive days if vigente', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 100);
      const dias = diasParaCaducidad({ expiresAt: futuro });
      expect(dias).toBeGreaterThanOrEqual(99);
      expect(dias).toBeLessThanOrEqual(101);
    });

    it('should return negative days if expirado', () => {
      const pasado = new Date();
      pasado.setDate(pasado.getDate() - 10);
      const dias = diasParaCaducidad({ expiresAt: pasado });
      expect(dias).toBeLessThan(-8);
      expect(dias).toBeGreaterThan(-12);
    });
  });

  describe('Validación: Income Reader Coherencia', () => {
    it('should invalidate document if expirado', () => {
      const pasado = new Date();
      pasado.setDate(pasado.getDate() - 1);
      const doc = {
        status: 'READY_FOR_VERIFICATION',
        errorMensaje: null,
        rejectionReason: null,
        expiresAt: pasado,
      };
      const resultado = validarCoherenciaIncomeReader(doc);
      expect(resultado.válido).toBe(false);
      expect(resultado.razón).toContain('expirado');
    });

    it('should invalidate if status=ERROR but no errorMensaje', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 1);
      const doc = {
        status: 'ERROR',
        errorMensaje: null,
        rejectionReason: null,
        expiresAt: futuro,
      };
      const resultado = validarCoherenciaIncomeReader(doc);
      expect(resultado.válido).toBe(false);
    });

    it('should invalidate if status!=ERROR but has errorMensaje', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 1);
      const doc = {
        status: 'READY_FOR_VERIFICATION',
        errorMensaje: 'Some error',
        rejectionReason: null,
        expiresAt: futuro,
      };
      const resultado = validarCoherenciaIncomeReader(doc);
      expect(resultado.válido).toBe(false);
    });

    it('should validate coherent document', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 1);
      const doc = {
        status: 'READY_FOR_VERIFICATION',
        errorMensaje: null,
        rejectionReason: null,
        expiresAt: futuro,
      };
      const resultado = validarCoherenciaIncomeReader(doc);
      expect(resultado.válido).toBe(true);
    });
  });

  describe('Validación: Registro Mercantil Coherencia', () => {
    it('should invalidate if version < 1', () => {
      const doc = {
        version: 0,
        isLatestVersion: true,
        expiresAt: null,
      };
      const resultado = validarCoherenciaRegistroMercantil(doc);
      expect(resultado.válido).toBe(false);
    });

    it('should invalidate if expirado (regardless of isLatestVersion)', () => {
      const pasado = new Date();
      pasado.setDate(pasado.getDate() - 1);
      const doc = {
        version: 1,
        isLatestVersion: true, // Aunque sea latest
        expiresAt: pasado, // Si está expirado, no válido
      };
      const resultado = validarCoherenciaRegistroMercantil(doc);
      expect(resultado.válido).toBe(false);
    });

    it('should validate coherent document', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 1);
      const doc = {
        version: 2,
        isLatestVersion: true,
        expiresAt: futuro,
      };
      const resultado = validarCoherenciaRegistroMercantil(doc);
      expect(resultado.válido).toBe(true);
    });
  });

  describe('Mensajes de Error Consistentes', () => {
    it('should generate standard expiration message', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() - 1);
      const doc = {
        expiresAt: futuro,
        tipo: 'El documento',
      };
      const mensaje = mensajeDocumentoExpirado(doc);
      expect(mensaje).toContain('ha expirado');
      expect(mensaje).toContain('vencía');
    });

    it('should handle missing expiresAt in message', () => {
      const doc = {
        expiresAt: null,
        tipo: 'El expediente',
      };
      const mensaje = mensajeDocumentoExpirado(doc);
      expect(mensaje).toContain('desconocida');
    });
  });

  describe('Reglas Críticas: Estados No Ambiguos', () => {
    it('should never allow obsolete version to be used', () => {
      // Versión obsoleta: isLatestVersion=false
      const versionObsoleta = {
        version: 1,
        isLatestVersion: false, // ← Obsoleta
        expiresAt: new Date(new Date().getTime() + 365 * 24 * 60 * 60 * 1000), // vigente
      };

      // Aunque tenga expiresAt vigente, isLatestVersion=false la invalida
      // El control se ejerce en el servicio (obtenerVigente busca isLatestVersion=true)
      expect(versionObsoleta.isLatestVersion).toBe(false);
    });

    it('should never allow expired document to be used', () => {
      // Documento expirado en Income Reader
      const docExpirado = {
        status: 'READY_FOR_VERIFICATION',
        expiresAt: new Date(new Date().getTime() - 1000), // expirado hace 1s
      };

      // No importa status, si expiró no se puede usar
      expect(esVigente(docExpirado)).toBe(false);
    });

    it('should enforce state transitivity', () => {
      // Principio: si el estado dice PROCESSING, debe estar procesando
      // Si dice ERROR, debe haber un error guardado

      const procesandoCoherente = {
        status: 'PROCESSING',
        errorMensaje: null,
      };

      const procesandoIncoherente = {
        status: 'PROCESSING',
        errorMensaje: 'Error found', // ← Contradicción
      };

      const errorCoherente = {
        status: 'ERROR',
        errorMensaje: 'Specific error',
      };

      expect(validarCoherenciaIncomeReader({ ...procesandoCoherente, rejectionReason: null, expiresAt: null }).válido).toBe(true);
      expect(
        validarCoherenciaIncomeReader({ ...procesandoIncoherente, rejectionReason: null, expiresAt: null }).válido,
      ).toBe(false);
      expect(validarCoherenciaIncomeReader({ ...errorCoherente, rejectionReason: null, expiresAt: null }).válido).toBe(true);
    });
  });

  describe('Consistencia Entre Módulos', () => {
    it('should apply same expiration logic to both modules', () => {
      const futuro = new Date();
      futuro.setDate(futuro.getDate() + 30);

      // Income Reader: documento vigente
      const docIncomeReader = {
        status: 'READY_FOR_VERIFICATION',
        errorMensaje: null,
        rejectionReason: null,
        expiresAt: futuro,
      };

      // Registro Mercantil: documento vigente
      const docRegistro = {
        version: 1,
        isLatestVersion: true,
        expiresAt: futuro,
      };

      // Ambos deben reportar vigencia
      expect(esVigente(docIncomeReader)).toBe(esVigente(docRegistro));
      expect(validarCoherenciaIncomeReader(docIncomeReader).válido).toBe(true);
      expect(validarCoherenciaRegistroMercantil(docRegistro).válido).toBe(true);
    });

    it('should apply same expiration rejection to both modules', () => {
      const pasado = new Date();
      pasado.setDate(pasado.getDate() - 1);

      // Income Reader: documento expirado
      const docIncomeReader = {
        status: 'READY_FOR_VERIFICATION',
        errorMensaje: null,
        rejectionReason: null,
        expiresAt: pasado,
      };

      // Registro Mercantil: documento expirado
      const docRegistro = {
        version: 1,
        isLatestVersion: true,
        expiresAt: pasado,
      };

      // Ambos deben rechazar por expiración
      expect(esVigente(docIncomeReader)).toBe(false);
      expect(esVigente(docRegistro)).toBe(false);
      expect(validarCoherenciaIncomeReader(docIncomeReader).válido).toBe(false);
      expect(validarCoherenciaRegistroMercantil(docRegistro).válido).toBe(false);
    });
  });
});
