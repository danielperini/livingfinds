/**
 * Normaliza texto para comparação: lowercase, sem acentos, espaços simples.
 */
export function normalize(text: string): string {
  if (!text) return '';
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}