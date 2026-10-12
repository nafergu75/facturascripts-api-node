/**
 * Reglas de Configuración > Usuarios (funciones puras): quién puede hacer qué
 * con cada usuario desde una empresa, el estado de la cuenta y la validación
 * del nombre y el teléfono.
 */
import { describe, it, expect } from '@jest/globals';
import {
  accionesPermitidas,
  estadoDe,
  motivoNoDatosPersonales,
  motivoNoEditarAcceso,
  motivoNoNuevaContrasena,
  MENSAJE_CONTRASENA_OTRAS_EMPRESAS,
  MENSAJE_ES_ADMIN_GLOBAL,
  type Objetivo,
} from '../services/usuariosEmpresa.service';
import { normalizarNombrePersona, normalizarTelefono } from '../services/admin.service';

const adminA = { userId: 'admin-a', esAdminGlobal: false };
const global = { userId: 'g', esAdminGlobal: true };
const objetivo = (o: Partial<Objetivo> = {}): Objetivo => ({ userId: 'u', esAdminGlobal: false, activo: true, rol: 'contable', empresas: ['A'], ...o });
const soloA = new Set(['A']);

describe('quién puede hacer qué desde una empresa', () => {
  it('al administrador global solo lo toca otro administrador global', () => {
    expect(motivoNoEditarAcceso(adminA, objetivo({ esAdminGlobal: true }))).toBe(MENSAJE_ES_ADMIN_GLOBAL);
    expect(motivoNoNuevaContrasena(adminA, objetivo({ esAdminGlobal: true }), soloA)).toBe(MENSAJE_ES_ADMIN_GLOBAL);
    expect(motivoNoEditarAcceso(global, objetivo({ esAdminGlobal: true }))).toBeNull();
  });

  it('la contraseña y los datos personales, solo si la cuenta entra únicamente en empresas que administra', () => {
    expect(motivoNoNuevaContrasena(adminA, objetivo(), soloA)).toBeNull();
    expect(motivoNoNuevaContrasena(adminA, objetivo({ empresas: ['A', 'B'] }), soloA)).toBe(MENSAJE_CONTRASENA_OTRAS_EMPRESAS);
    expect(motivoNoNuevaContrasena(adminA, objetivo({ empresas: ['A', 'B'] }), new Set(['A', 'B']))).toBeNull();
    expect(motivoNoDatosPersonales(adminA, objetivo({ empresas: ['A', 'B'] }), soloA)).not.toBeNull();
    expect(motivoNoNuevaContrasena(global, objetivo({ empresas: ['A', 'B'] }), 'todas')).toBeNull();
  });

  it('la propia contraseña nunca, y el último administrador activo no se quita', () => {
    expect(accionesPermitidas(adminA, objetivo({ userId: 'admin-a', rol: 'admin' }), soloA, ['admin-a'])).toEqual({
      editarAcceso: true,
      nuevaContrasena: false,
      quitarAcceso: false,
    });
    expect(accionesPermitidas(adminA, objetivo({ userId: 'admin-a', rol: 'admin' }), soloA, ['admin-a', 'otro']).quitarAcceso).toBe(true);
    // Un administrador desactivado no está en la lista de activos: se le puede quitar.
    expect(accionesPermitidas(adminA, objetivo({ rol: 'admin', activo: false }), soloA, ['admin-a']).quitarAcceso).toBe(true);
  });
});

describe('estado de la cuenta', () => {
  const ahora = new Date('2026-10-12T10:00:00Z');
  it('desactivado, provisional caducada, provisional pendiente o activo', () => {
    expect(estadoDe({ isActive: false, debeCambiarContrasena: true, contrasenaProvisionalHasta: null }, ahora)).toBe('desactivado');
    expect(estadoDe({ isActive: true, debeCambiarContrasena: true, contrasenaProvisionalHasta: new Date('2026-10-01') }, ahora)).toBe('contrasena_caducada');
    expect(estadoDe({ isActive: true, debeCambiarContrasena: true, contrasenaProvisionalHasta: new Date('2026-10-19') }, ahora)).toBe('contrasena_pendiente');
    expect(estadoDe({ isActive: true, debeCambiarContrasena: true, contrasenaProvisionalHasta: null }, ahora)).toBe('contrasena_pendiente');
    expect(estadoDe({ isActive: true, debeCambiarContrasena: false, contrasenaProvisionalHasta: null }, ahora)).toBe('activo');
  });
});

describe('nombre y teléfono', () => {
  it('el nombre se limpia y es obligatorio', () => {
    expect(normalizarNombrePersona('  Lucía   Pérez ')).toBe('Lucía Pérez');
    expect(() => normalizarNombrePersona('')).toThrow('Escribe el nombre y apellidos.');
    expect(() => normalizarNombrePersona('x')).toThrow('demasiado corto');
    expect(() => normalizarNombrePersona('x'.repeat(121))).toThrow('120');
  });

  it('el teléfono es opcional: vacío es null; si viene, solo cifras y signos de teléfono', () => {
    expect(normalizarTelefono(undefined)).toBeNull();
    expect(normalizarTelefono('  ')).toBeNull();
    expect(normalizarTelefono('+34 (960) 00-00-00')).toBe('+34 (960) 00-00-00');
    expect(() => normalizarTelefono('llámame')).toThrow();
    expect(() => normalizarTelefono('12345')).toThrow();
    expect(() => normalizarTelefono(600112233)).toThrow();
  });
});
