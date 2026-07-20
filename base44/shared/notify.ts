/**
 * notify.ts — Notificações via Discord (webhook).
 *
 * Entrega dois pontos do briefing:
 *  - Alerta quando a Amazon exige reconexão (#5 "a API cai sem aviso").
 *  - Notificações após o processamento noturno (item de notificações).
 *
 * `buildDiscordPayload` é puro (testável). `sendDiscordAlert` posta no DISCORD_WEBHOOK_URL;
 * se a env não estiver setada, vira no-op silencioso (não quebra o fluxo).
 */
// deno-lint-ignore no-explicit-any
type Any = any;

export type AlertLevel = 'info' | 'warn' | 'error' | 'success';

export interface AlertInput {
  title: string;
  message: string;
  level?: AlertLevel;
  fields?: { name: string; value: string }[];
  source?: string;
}

const COLORS: Record<AlertLevel, number> = {
  info: 3447003, // azul
  warn: 16098851, // amarelo
  error: 15158332, // vermelho
  success: 3066993, // verde
};

/** Monta o corpo do webhook do Discord (função pura — testável sem rede). */
export function buildDiscordPayload(input: AlertInput, isoTimestamp: string): Any {
  const level = input.level ?? 'info';
  const emoji = level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
  return {
    username: 'Living Finds',
    embeds: [{
      title: `${emoji} ${input.title}`,
      description: input.message,
      color: COLORS[level],
      fields: (input.fields ?? []).slice(0, 25).map((f) => ({
        name: f.name, value: f.value, inline: true,
      })),
      footer: { text: input.source ?? 'Living Finds — automação Amazon Ads' },
      timestamp: isoTimestamp,
    }],
  };
}

/** Envia um alerta ao Discord. No-op se DISCORD_WEBHOOK_URL não estiver configurado. */
export async function sendDiscordAlert(input: AlertInput): Promise<{ sent: boolean; reason?: string }> {
  const url = Deno.env.get('DISCORD_WEBHOOK_URL');
  if (!url) return { sent: false, reason: 'DISCORD_WEBHOOK_URL não configurado' };
  try {
    const payload = buildDiscordPayload(input, new Date().toISOString());
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: (e as Error)?.message };
  }
}
