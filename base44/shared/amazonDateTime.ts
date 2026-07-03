const BRAZIL_TZ = 'America/Sao_Paulo';

export function toAmazonUtcDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida');
  return date.toISOString();
}

export function formatAmazonDate(value: string | number | Date): string {
  return toAmazonUtcDateTime(value).slice(0, 10);
}

export function parseAmazonDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Data Amazon inválida: ${value}`);
  return date;
}

export function getBrazilHour(value: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: BRAZIL_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(value);
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

export function getBrazilDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRAZIL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function getBrazilDayRangeUtc(dateText?: string): { start: string; end: string } {
  const day = dateText || getBrazilDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Data deve estar em YYYY-MM-DD');
  const start = new Date(`${day}T00:00:00-03:00`);
  const end = new Date(`${day}T23:59:59.999-03:00`);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function getQueueWindowUtc(hour: number, dateText?: string): { start: string; end: string } {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Hora inválida');
  const day = dateText || getBrazilDate();
  const hh = String(hour).padStart(2, '0');
  const next = String((hour + 1) % 24).padStart(2, '0');
  const start = new Date(`${day}T${hh}:00:00-03:00`);
  const endDay = hour === 23 ? new Date(`${day}T23:59:59.999-03:00`) : new Date(`${day}T${next}:00:00-03:00`);
  return { start: start.toISOString(), end: endDay.toISOString() };
}

export const AMAZON_TIME_ZONE = BRAZIL_TZ;
