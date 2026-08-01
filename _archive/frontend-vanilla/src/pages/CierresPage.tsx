import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, eur, TituloPagina } from '../app/ui';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const COLOR_PERIODO: Record<string, { bg: string; fg: string }> = {
  abierto: { bg: '#d1f7dd', fg: '#0f7a3d' },
  bloqueado: { bg: '#ffe3c2', fg: '#b35c00' },
  cerrado: { bg: '#e8e8e8', fg: '#666' },
};

/**
 * Cierres: rejilla de periodos (abierto/bloqueado/cerrado) + chequeo previo
 * (cuadre de bancos) + CIERRE REAL del ejercicio (regularizacion + cierre +
 * apertura) con confirmacion. El backend devuelve 409 si los bancos descuadran.
 */
export function CierresPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [ejercicio, setEjercicio] = useState(new Date().getFullYear());
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [chequeo, setChequeo] = useState<{ puedeCerrar: boolean; motivo: string | null; cuadre: { totalDiferencia: number; todasCuadran: boolean } } | null>(null);

  const { datos: periodos, cargando, error, recargar, setError } = useCarga(() => api.getPeriodos(ejercicio), [api, sesion.companyId, ejercicio]);

  const cambiar = async (mes: number, estado: string): Promise<void> => {
    try {
      await api.cambiarEstadoPeriodo(ejercicio, mes, estado);
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  };

  const cerrarTodos = async (): Promise<void> => {
    if (!window.confirm(`Cerrar los 12 periodos de ${ejercicio}? Las fechas de esos meses quedaran bloqueadas para nuevas facturas.`)) return;
    for (let m = 1; m <= 12; m++) await api.cambiarEstadoPeriodo(ejercicio, m, 'cerrado').catch(() => undefined);
    await recargar();
  };

  const comprobar = async (): Promise<void> => {
    setError(null);
    try {
      setChequeo(await api.getChequeoCierre(ejercicio));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en el chequeo');
    }
  };

  const ejecutarCierre = async (): Promise<void> => {
    if (!window.confirm(`CIERRE REAL del ejercicio ${ejercicio}: se crearan los asientos de regularizacion (6/7 -> 129), cierre y apertura. ¿Continuar?`)) return;
    setMensaje(null);
    setError(null);
    try {
      const r = (await api.ejecutarCierre(ejercicio)) as Record<string, unknown>;
      setMensaje(`Cierre ejecutado. Resultado del ejercicio: ${eur(Number(r.resultadoEjercicio ?? 0))}. Asientos: regularizacion ${r.asientoRegularizacionId}, cierre ${r.asientoCierreId}, apertura ${r.asientoAperturaId}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'El cierre fue bloqueado');
    }
  };

  return (
    <div>
      <TituloPagina
        acciones={
          <label style={{ fontSize: 13, color: '#445' }}>
            Ejercicio <input type="number" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))} style={{ width: 80, padding: 5, borderRadius: 6, border: '1px solid #ccd' }} />
          </label>
        }
      >
        Cierre del ejercicio
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}
      {mensaje && <div style={{ background: '#e6f6ec', color: '#0f7a3d', padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{mensaje}</div>}

      {/* Paso 1: periodos */}
      <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 14, marginBottom: 14 }}>
        <b style={{ fontSize: 13 }}>1 · Periodos mensuales</b>
        <p style={{ fontSize: 12, color: '#667', margin: '4px 0 10px' }}>Para cerrar el ejercicio, ningun mes puede seguir abierto. Clic en un mes para alternar abierto → bloqueado → cerrado.</p>
        {cargando ? (
          <Cargando />
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(periodos ?? []).map((p) => {
              const c = COLOR_PERIODO[p.estado] ?? COLOR_PERIODO.abierto;
              const siguiente = p.estado === 'abierto' ? 'bloqueado' : p.estado === 'bloqueado' ? 'cerrado' : 'abierto';
              return (
                <button
                  key={p.mes}
                  onClick={() => void cambiar(p.mes, siguiente)}
                  title={`${p.estado} → ${siguiente}`}
                  style={{ background: c.bg, color: c.fg, border: 'none', borderRadius: 8, padding: '10px 0', width: 64, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
                >
                  {MESES[p.mes - 1]}
                  <div style={{ fontWeight: 400, fontSize: 10 }}>{p.estado}</div>
                </button>
              );
            })}
          </div>
        )}
        <button style={{ ...btn, marginTop: 10 }} onClick={() => void cerrarTodos()}>
          Cerrar los 12 meses
        </button>
      </div>

      {/* Paso 2: chequeo (cuadre de bancos) */}
      <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 14, marginBottom: 14 }}>
        <b style={{ fontSize: 13 }}>2 · Chequeo previo (cuadre de bancos)</b>
        <p style={{ fontSize: 12, color: '#667', margin: '4px 0 10px' }}>El cierre se bloquea (409) si el saldo contable 57x no cuadra con los extractos importados.</p>
        <button style={btn} onClick={() => void comprobar()}>
          Comprobar si se puede cerrar
        </button>
        {chequeo && (
          <span style={{ marginLeft: 10, fontSize: 13, color: chequeo.puedeCerrar ? '#0f7a3d' : '#b35c00', fontWeight: 600 }}>
            {chequeo.puedeCerrar ? '✓ Todo cuadra: se puede cerrar.' : `⚠ ${chequeo.motivo} (diferencia total ${eur(chequeo.cuadre.totalDiferencia)})`}
          </span>
        )}
      </div>

      {/* Paso 3: cierre real */}
      <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 14 }}>
        <b style={{ fontSize: 13 }}>3 · Ejecutar el cierre</b>
        <p style={{ fontSize: 12, color: '#667', margin: '4px 0 10px' }}>Crea en FacturaScripts los asientos de regularizacion (grupos 6/7 contra 129), cierre de balance y apertura del ejercicio siguiente.</p>
        <button style={{ ...btnPrimario, background: '#b3261e' }} onClick={() => void ejecutarCierre()}>
          Cerrar ejercicio {ejercicio}
        </button>
      </div>
    </div>
  );
}
