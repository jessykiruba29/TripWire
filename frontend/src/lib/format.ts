/**
 * Formatting helpers. All dates come from the backend as ISO-8601 UTC strings;
 * they are rendered in the viewer's locale, with the raw value available on
 * `title` attributes so nothing is hidden.
 */

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

const DATE_ONLY: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: '2-digit' };

export function formatDateTime(iso?: string | null): string {
  const date = parse(iso);
  return date ? new Intl.DateTimeFormat(undefined, DATE_TIME).format(date) : '—';
}

export function formatDate(iso?: string | null): string {
  const date = parse(iso);
  return date ? new Intl.DateTimeFormat(undefined, DATE_ONLY).format(date) : '—';
}

export function formatDay(iso?: string | null): string {
  const date = parse(iso);
  return date ? new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit' }).format(date) : '—';
}

/** ISO date (YYYY-MM-DD) suitable for `<input type="date">`. */
export function toDateInputValue(iso?: string | null): string {
  const date = parse(iso);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local-midnight ISO string for the day containing `iso`, for history queries. */
export function toDayStartIso(dateInput: string): string {
  const [y, m, d] = dateInput.split('-').map(Number);
  if (!y || !m || !d) return new Date().toISOString();
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

export function formatRelative(iso?: string | null, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return '—';
  const diffMs = now.getTime() - date.getTime();
  const past = diffMs >= 0;
  const abs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const pick = (): string => {
    if (abs < minute) return 'moments';
    if (abs < hour) return `${Math.round(abs / minute)} min`;
    if (abs < day) return `${Math.round(abs / hour)} h`;
    if (abs < 30 * day) return `${Math.round(abs / day)} d`;
    if (abs < 365 * day) return `${Math.round(abs / (30 * day))} mo`;
    return `${Math.round(abs / (365 * day))} y`;
  };

  return past ? `${pick()} ago` : `in ${pick()}`;
}

/** Renders the difference between "true in the world" and "known to Tripwire". */
export function describeBitemporal(validFrom?: string | null, recordedAt?: string | null): string | null {
  const valid = parse(validFrom);
  const recorded = parse(recordedAt);
  if (!valid || !recorded) return null;
  const days = Math.round((recorded.getTime() - valid.getTime()) / 86_400_000);
  if (days <= 0) return 'Recorded when it became true.';
  return `True in the world from ${formatDate(validFrom)}, but Tripwire only learned about it on ${formatDate(recordedAt)} (${days} day${days === 1 ? '' : 's'} later).`;
}

export function formatPercent(value?: number | null, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Human labels for ids, used when a node label is missing. */
export function humaniseId(id: string): string {
  return id
    .replace(/^[A-Z]+-/, '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parse(iso?: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
