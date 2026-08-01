import { ModeloImpuestoDetalle, ModeloImpuestoResumen, Casillas, TabImpuestos } from './types';

/**
 * Cliente REST del modulo Impuestos. Encapsula las rutas REALES del backend:
 *   GET  /companies/:id/impuestos/modelos?ejercicio=&tab=
 *   GET  /companies/:id/impuestos/modelos/:modeloId
 *   POST /companies/:id/impuestos/modelos/:modeloId/recalcular   ("autorrellenar")
 *   PUT  /companies/:id/impuestos/modelos/:modeloId              ("guardar" manual)
 *   POST .../omitir | /recuperar | /listo-para-presentar | /no-presentado
 *   GET  .../txt | .../pdf
 *   GET  /companies/:id/impuestos/ingresos-gastos/excel?ejercicio=&periodo=
 * (El prompt referenciaba /autorrellenar y /guardar: aqui mapean a /recalcular y PUT.)
 */
export class ImpuestosApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly companyId: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl}/companies/${this.companyId}/impuestos${path}`;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
    return body.data as T; // el backend envuelve en { ok, data }
  }

  listarModelos(ejercicio: number, tab: TabImpuestos = 'activos'): Promise<ModeloImpuestoResumen[]> {
    return this.json(`/modelos?ejercicio=${ejercicio}&tab=${tab}`);
  }

  obtenerDetalle(modeloId: string): Promise<ModeloImpuestoDetalle> {
    return this.json(`/modelos/${modeloId}`);
  }

  /** "Recalcular importes": autorrellena y GUARDA automaticamente (pisa lo manual). */
  recalcular(modeloId: string): Promise<ModeloImpuestoDetalle> {
    return this.json(`/modelos/${modeloId}/recalcular`, { method: 'POST' });
  }

  /** "Guardar": conserva las ediciones manuales (origen manual-mixto). */
  guardar(modeloId: string, casillas: Casillas): Promise<ModeloImpuestoDetalle> {
    return this.json(`/modelos/${modeloId}`, { method: 'PUT', body: JSON.stringify({ casillas }) });
  }

  omitir(modeloId: string): Promise<ModeloImpuestoResumen> {
    return this.json(`/modelos/${modeloId}/omitir`, { method: 'POST' });
  }
  recuperar(modeloId: string): Promise<ModeloImpuestoResumen> {
    return this.json(`/modelos/${modeloId}/recuperar`, { method: 'POST' });
  }
  listoParaPresentar(modeloId: string): Promise<ModeloImpuestoResumen> {
    return this.json(`/modelos/${modeloId}/listo-para-presentar`, { method: 'POST' });
  }
  noPresentado(modeloId: string): Promise<ModeloImpuestoResumen> {
    return this.json(`/modelos/${modeloId}/no-presentado`, { method: 'POST' });
  }

  /** Descarga un binario autenticado y dispara el "guardar como" del navegador. */
  private async descargar(path: string, nombrePorDefecto: string): Promise<void> {
    const res = await fetch(this.url(path), { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`Descarga fallida (HTTP ${res.status})`);
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const nombre = /filename="([^"]+)"/.exec(disposition)?.[1] ?? nombrePorDefecto;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  descargarTxt(modeloId: string): Promise<void> {
    return this.descargar(`/modelos/${modeloId}/txt`, 'modelo.txt');
  }
  descargarPdf(modeloId: string): Promise<void> {
    return this.descargar(`/modelos/${modeloId}/pdf`, 'modelo.pdf');
  }
  descargarExcelIngresosGastos(ejercicio: number, periodo?: string): Promise<void> {
    const q = `ejercicio=${ejercicio}${periodo ? `&periodo=${periodo}` : ''}`;
    return this.descargar(`/ingresos-gastos/excel?${q}`, 'ingresos_gastos.xlsx');
  }
}

/** URL de la Sede AEAT para presentar el TXT (boton "Ir a la AEAT"). */
export const URL_SEDE_AEAT = 'https://sede.agenciatributaria.gob.es/';
