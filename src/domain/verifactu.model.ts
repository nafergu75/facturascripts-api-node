export interface HuellaFactura {
  id: string;
  companyId: string;
  facturaId: string; // ID interna o de FacturaScripts
  hash: string; // hash del contenido
  algoritmo: string; // 'SHA256'
  cadenaOriginal: string; // representacion canonica usada para el hash
  hashAnterior?: string; // encadenamiento (inalterabilidad), estilo Veri*Factu
  creadaEn: string;
}
