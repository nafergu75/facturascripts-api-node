import { permisosDeRoles, usuarioTienePermiso } from '../services/rbac.service';
import { extraerMovimientosCaja, proponer, puntuar } from '../services/conciliacion.service';
import { exportarReporteMargenCSV } from '../services/export.service';
import { AsientoSimple } from '../services/contabilidadDatos.service';

describe('RBAC', () => {
  it('admin tiene cualquier permiso; contable solo los suyos', () => {
    expect(usuarioTienePermiso(permisosDeRoles(['admin']), 'tesoreria:write')).toBe(true);
    expect(usuarioTienePermiso(permisosDeRoles(['contable']), 'contabilidad:write')).toBe(true);
    expect(usuarioTienePermiso(permisosDeRoles(['contable']), 'tesoreria:write')).toBe(false);
  });
  it('solo-lectura solo permisos :read', () => {
    const p = permisosDeRoles(['solo-lectura']);
    expect(usuarioTienePermiso(p, 'contabilidad:read')).toBe(true);
    expect(usuarioTienePermiso(p, 'contabilidad:write')).toBe(false);
  });
});

describe('Conciliacion bancaria', () => {
  const asientos: AsientoSimple[] = [
    { idasiento: 1, fecha: '2026-06-10', numero: 1, concepto: 'Cobro factura cliente A', lineas: [
      { subcuenta: '5720000000', debe: 363, haber: 0 },
      { subcuenta: '4300000000', debe: 0, haber: 363 },
    ] },
  ];

  it('extrae movimientos de caja (lineas 57x)', () => {
    const caja = extraerMovimientosCaja(asientos);
    expect(caja).toHaveLength(1);
    expect(caja[0].importe).toBe(363);
  });

  it('puntua alto un movimiento que coincide en importe y fecha', () => {
    const caja = extraerMovimientosCaja(asientos);
    const sugerencias = proponer(
      [{ fecha: '2026-06-10', importe: 363, concepto: 'Cobro factura cliente A' }],
      caja,
    );
    expect(sugerencias[0].asientosCandidatos[0].score).toBeGreaterThan(0.9);
  });

  it('puntua bajo un importe muy distinto (la fecha aporta poco)', () => {
    const caja = extraerMovimientosCaja(asientos);
    // importe distinto -> 0; fecha igual -> 0.3; texto sin solape -> 0 => 0.3 total
    expect(puntuar({ fecha: '2026-06-10', importe: 9999, concepto: 'otro' }, caja[0])).toBeLessThan(0.5);
    // ademas, distinto importe Y distinta fecha -> 0
    expect(puntuar({ fecha: '2025-01-01', importe: 9999, concepto: 'otro' }, caja[0])).toBe(0);
  });
});

describe('Export CSV', () => {
  it('genera CSV de reporte de margen', () => {
    const csv = exportarReporteMargenCSV({
      companyId: '1', ejercicio: 2026, criterio: 'cliente',
      filas: [{ clave: 'C1', nombre: 'Cliente A', ventas: 1000, coste: 600, margen: 400, margenPorcentaje: 40 }],
    });
    expect(csv).toContain('clave;nombre;ventas;coste;margen;margen%');
    expect(csv).toContain('C1;Cliente A;1000;600;400;40');
  });
});
