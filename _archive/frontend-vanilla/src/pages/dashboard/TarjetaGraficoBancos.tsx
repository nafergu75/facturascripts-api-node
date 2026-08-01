import React, { memo, useMemo } from 'react';
import { PeriodoBasico, PuntoSerieBanco } from '../../app/dashboardApi';
import { EstadoVacio, eur, SkeletonBloque } from '../../app/ui';
import { LineaSerie } from '../../app/charts';

/**
 * Tarjeta de grafico de bancos (componente "tonto"). El rango (7d/30d/completo)
 * lo controla el padre via onPeriodoBasicoChange para recargar la serie.
 * Grafico de LINEA: es lo recomendado para evolucion temporal de saldo.
 */
export interface TarjetaGraficoBancosProps {
  serie: PuntoSerieBanco[] | null;
  periodoBasico: PeriodoBasico;
  onPeriodoBasicoChange: (p: PeriodoBasico) => void;
  isLoading: boolean;
}

const RANGOS: Array<{ id: PeriodoBasico; etiqueta: string }> = [
  { id: '7d', etiqueta: '7 dias' },
  { id: '30d', etiqueta: '30 dias' },
  { id: 'periodoCompleto', etiqueta: 'Periodo completo' },
];

export const TarjetaGraficoBancos = memo(function TarjetaGraficoBancos(props: TarjetaGraficoBancosProps): React.ReactElement {
  const { minimo, maximo } = useMemo(() => {
    const vals = (props.serie ?? []).map((p) => p.valor);
    return { minimo: vals.length ? Math.min(...vals) : 0, maximo: vals.length ? Math.max(...vals) : 0 };
  }, [props.serie]);

  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Evolucion saldo bancos</b>
        <div style={{ marginLeft: 'auto' }}>
          {RANGOS.map((r) => (
            <button
              key={r.id}
              onClick={() => props.onPeriodoBasicoChange(r.id)}
              style={{
                padding: '4px 10px',
                marginLeft: 4,
                borderRadius: 12,
                border: props.periodoBasico === r.id ? 'none' : '1px solid #ccd',
                background: props.periodoBasico === r.id ? '#1a56b0' : '#fff',
                color: props.periodoBasico === r.id ? '#fff' : '#445',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {r.etiqueta}
            </button>
          ))}
        </div>
      </div>
      {props.isLoading ? (
        <SkeletonBloque alto={210} lineas={2} />
      ) : !props.serie || props.serie.length === 0 ? (
        <EstadoVacio mensaje="No hay datos para el rango seleccionado." />
      ) : (
        <>
          <LineaSerie puntos={props.serie} />
          <div style={{ fontSize: 12, color: '#778', marginTop: 4 }}>
            Saldo minimo en el rango: <b>{eur(minimo)}</b> · maximo: <b>{eur(maximo)}</b>
          </div>
        </>
      )}
    </div>
  );
});
