export type DaypartWindow = 'PAUSE_ALL' | 'FULL' | 'REDUCE_60_PAUSE_AUTO' | 'HALF';

export type DaypartPolicy = {
  window: DaypartWindow;
  bidMultiplier: number;
  pauseAll: boolean;
  pauseAutomatic: boolean;
  restoreCampaigns: boolean;
  isWeekendOrHoliday: boolean;
  windowKey: string;
};

function brtParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const weekday = get('weekday');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday,
    minuteOfDay: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

export function normalizeHolidayDates(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.map(String).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(String(value));
    return normalizeHolidayDates(parsed);
  } catch {
    return new Set(String(value).split(',').map((date) => date.trim()).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  }
}

export function resolveScheduledAdsDaypart(now: Date, holidayDates: Set<string> = new Set()): DaypartPolicy {
  const clock = brtParts(now);
  const weekend = clock.weekday === 'Sat' || clock.weekday === 'Sun';
  const isWeekendOrHoliday = weekend || holidayDates.has(clock.date);
  const minute = clock.minuteOfDay;

  let window: DaypartWindow = 'FULL';
  let bidMultiplier = 1;
  let pauseAll = false;
  let pauseAutomatic = false;
  let restoreCampaigns = false;

  if (isWeekendOrHoliday) {
    if (minute >= 23 * 60 + 59 || minute < 5 * 60) {
      window = 'HALF';
      bidMultiplier = 0.5;
    } else {
      window = 'FULL';
      restoreCampaigns = minute >= 5 * 60;
    }
  } else if (minute >= 3 * 60 && minute < 5 * 60) {
    window = 'PAUSE_ALL';
    bidMultiplier = 0.5;
    pauseAll = true;
  } else if (minute >= 15 * 60 && minute < 17 * 60) {
    window = 'REDUCE_60_PAUSE_AUTO';
    bidMultiplier = 0.4;
    pauseAutomatic = true;
  } else if (minute >= 23 * 60 + 59 || minute < 3 * 60) {
    window = 'HALF';
    bidMultiplier = 0.5;
  } else {
    window = 'FULL';
    restoreCampaigns = minute >= 5 * 60;
  }

  return {
    window,
    bidMultiplier,
    pauseAll,
    pauseAutomatic,
    restoreCampaigns,
    isWeekendOrHoliday,
    windowKey: `${clock.date}|${window}`,
  };
}

export function targetBidFromBaseline(baselineBid: number, multiplier: number, minBid = 0.02): number {
  if (!Number.isFinite(baselineBid) || baselineBid <= 0) return 0;
  return Math.max(minBid, Math.round(baselineBid * multiplier * 100) / 100);
}
