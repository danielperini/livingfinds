export type PersistedDaypartRule = {
  id?: string;
  rule_name?: string;
  action_type?: string;
  scope_type?: string;
  campaign_ids?: string[];
  targeting_types?: string[];
  days_of_week?: string[];
  holiday_mode?: string;
  holiday_dates?: string[];
  timezone?: string;
  start_time?: string;
  end_time?: string;
  adjustment_value?: number;
  status?: string;
};

function partsAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: String(get('weekday')).toUpperCase(),
    minuteOfDay: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

function parseMinute(value: unknown): number | null {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function windowContext(rule: PersistedDaypartRule, now: Date) {
  const timeZone = rule.timezone || 'America/Sao_Paulo';
  const local = partsAt(now, timeZone);
  const start = parseMinute(rule.start_time);
  const end = parseMinute(rule.end_time);
  if (start === null || end === null || start === end) return null;
  const overnight = start > end;
  const inside = overnight
    ? local.minuteOfDay >= start || local.minuteOfDay < end
    : local.minuteOfDay >= start && local.minuteOfDay < end;
  if (!inside) return null;
  const startedPreviousDay = overnight && local.minuteOfDay < end;
  const anchor = startedPreviousDay ? partsAt(new Date(now.getTime() - 24 * 60 * 60_000), timeZone) : local;
  return { local, anchor };
}

export function ruleMatchesNow(rule: PersistedDaypartRule, now = new Date()): boolean {
  if (String(rule.status || '').toLowerCase() !== 'enabled') return false;
  const context = windowContext(rule, now);
  if (!context) return false;

  const holidays = new Set((rule.holiday_dates || []).map(String));
  const holiday = holidays.has(context.anchor.dateKey);
  const days = new Set((rule.days_of_week || []).map((day) => String(day).toUpperCase()));
  const holidayMode = String(rule.holiday_mode || 'IGNORE').toUpperCase();
  if ((holidayMode === 'WEEKEND_POLICY' || holidayMode === 'AUTO_BR') && holiday) return true;
  return days.has(context.anchor.weekday);
}

export function campaignMatchesRule(rule: PersistedDaypartRule, campaign: any): boolean {
  const campaignId = String(campaign.amazon_campaign_id || campaign.campaign_id || campaign.id || '');
  if (!campaignId) return false;
  if (String(rule.scope_type || 'ALL').toUpperCase() === 'SELECTED') {
    const selected = new Set((rule.campaign_ids || []).map(String));
    if (!selected.has(campaignId)) return false;
  }
  const targeting = (rule.targeting_types || []).map((value) => String(value).toUpperCase());
  if (targeting.length) {
    const campaignTargeting = String(campaign.targeting_type || '').toUpperCase();
    if (!targeting.includes(campaignTargeting)) return false;
  }
  return true;
}

export function bidMultiplierForRule(rule: PersistedDaypartRule): number {
  const adjustment = Number(rule.adjustment_value || 0);
  return Math.max(0, 1 + adjustment / 100);
}

export function ruleWindowKey(rule: PersistedDaypartRule, now = new Date()): string {
  const context = windowContext(rule, now);
  const anchorDate = context?.anchor.dateKey || partsAt(now, rule.timezone || 'America/Sao_Paulo').dateKey;
  return `${rule.id || rule.rule_name || 'rule'}|${anchorDate}|${rule.start_time || ''}-${rule.end_time || ''}`;
}
