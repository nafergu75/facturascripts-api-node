/**
 * Nombre de fichero apto para una ruta de almacenamiento. Los nombres llegan del
 * cliente: sin limpiar, "../../x" escribiria fuera de la carpeta prevista.
 * Se queda con el ultimo segmento y con caracteres seguros.
 */
export function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/).pop() ?? '';
  const limpio = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return limpio.slice(0, 120) || 'archivo';
}
