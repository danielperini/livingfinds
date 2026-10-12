import { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

function asCalendarDate(value) {
  return value ? parseISO(`${value}T12:00:00`) : undefined;
}

function asDateInputValue(value) {
  return value ? format(value, 'yyyy-MM-dd') : '';
}

function formatDateLabel(value) {
  return value ? format(asCalendarDate(value), 'dd/MM/yyyy') : '—';
}

export default function KickoffDateRangePicker({ startDate, endDate, onChange, onClear }) {
  const [open, setOpen] = useState(false);
  const selectedRange = useMemo(() => ({
    from: asCalendarDate(startDate),
    to: asCalendarDate(endDate),
  }), [startDate, endDate]);

  const updateStart = (value) => {
    onChange(value, endDate && endDate < value ? value : endDate);
  };

  const updateEnd = (value) => {
    onChange(startDate && startDate > value ? value : startDate, value);
  };

  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className="whitespace-nowrap">Período</span>
      <span className="hidden xl:inline text-slate-500">De</span>
      <input
        type="date"
        value={startDate}
        max={endDate || undefined}
        onChange={event => updateStart(event.target.value)}
        aria-label="Data inicial do período"
        className="w-[132px] rounded-lg border border-surface-3 bg-surface-2 px-2 py-1.5 text-xs text-slate-200 [color-scheme:dark]"
      />
      <span className="text-slate-500">até</span>
      <input
        type="date"
        value={endDate}
        min={startDate || undefined}
        onChange={event => updateEnd(event.target.value)}
        aria-label="Data final do período"
        className="w-[132px] rounded-lg border border-surface-3 bg-surface-2 px-2 py-1.5 text-xs text-slate-200 [color-scheme:dark]"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Abrir calendário do período: ${formatDateLabel(startDate)} até ${formatDateLabel(endDate)}`}
            title="Selecionar datas no calendário"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-3 bg-surface-2 text-slate-300 transition-colors hover:border-violet-400/40 hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            <CalendarDays className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(92vw,42rem)] border-surface-3 bg-[#12101b] p-3 text-slate-200 shadow-xl">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-surface-3 px-1 pb-3">
            <div>
              <p className="text-sm font-semibold text-white">Selecionar período</p>
              <p className="mt-0.5 text-xs text-slate-400">{formatDateLabel(startDate)} até {formatDateLabel(endDate)}</p>
            </div>
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-2 py-1 text-xs font-medium text-violet-300 hover:bg-violet-400/10 hover:text-violet-200"
            >
              Todo o período
            </button>
          </div>
          <Calendar
            mode="range"
            selected={selectedRange}
            onSelect={range => {
              if (!range) {
                onChange('', '');
                return;
              }
              onChange(asDateInputValue(range.from), asDateInputValue(range.to));
            }}
            numberOfMonths={2}
            initialFocus
            className="mx-auto text-slate-200"
            classNames={{
              caption_label: 'text-sm font-medium text-slate-100',
              head_cell: 'w-9 rounded-md text-xs font-normal text-slate-500',
              day: 'h-9 w-9 rounded-md p-0 font-normal text-slate-200 hover:bg-violet-400/20 hover:text-white',
              day_today: 'bg-surface-3 text-white',
              day_selected: 'bg-violet-500 text-white hover:bg-violet-500 hover:text-white',
              day_range_middle: 'aria-selected:bg-violet-500/20 aria-selected:text-violet-100',
              nav_button: 'h-7 w-7 rounded-md border border-surface-3 bg-surface-2 p-0 text-slate-300 hover:bg-surface-3',
            }}
          />
          <p className="mt-1 px-1 text-[11px] text-slate-500">O filtro considera a data da atividade do Kick-off, no horário de Brasília.</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
