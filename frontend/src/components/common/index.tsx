/**
 * Shared primitives used by every panel.
 *
 * These are intentionally dumb: no data fetching, no domain logic beyond the
 * tone vocabulary in `lib/vocabulary.ts`.
 */

import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import type { Tone } from '../../lib/vocabulary';
import { formatPercent } from '../../lib/format';
import { IconAlert, IconClose, IconInfo, IconRefresh } from './Icons';

/* ---------------------------------------------------------------------- Panel */

export function Panel({
  children,
  flush,
  plain,
  className,
}: {
  children: ReactNode;
  flush?: boolean;
  plain?: boolean;
  className?: string;
}) {
  const classes = ['panel', flush && 'panel--flush', plain && 'panel--plain', className].filter(Boolean).join(' ');
  return <section className={classes}>{children}</section>;
}

export function PanelHead({
  title,
  subtitle,
  actions,
  icon,
  level = 2,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <header className="panel__head">
      <div className="stack stack--tight" style={{ minWidth: 0 }}>
        <Heading className="panel__title">
          {icon}
          {title}
        </Heading>
        {subtitle ? <p className="panel__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="panel__actions">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({
  children,
  tight,
  scroll,
}: {
  children: ReactNode;
  tight?: boolean;
  scroll?: boolean;
}) {
  const classes = ['panel__body', tight && 'panel__body--tight', scroll && 'panel__body--scroll']
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}

export function PanelFoot({ children }: { children: ReactNode }) {
  return <footer className="panel__foot">{children}</footer>;
}

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <h4 className="section__title">{title}</h4>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------- Badge */

export function Badge({
  tone = 'neutral',
  children,
  dot,
  outline,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  outline?: boolean;
  title?: string;
}) {
  const classes = ['badge', `badge--${tone}`, outline && 'badge--outline'].filter(Boolean).join(' ');
  return (
    <span className={classes} title={title}>
      {dot ? <span className="badge__dot" /> : null}
      {children}
    </span>
  );
}

export function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="chip mono" title={title}>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------- Button */

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  disabled,
  busy,
  type = 'button',
  title,
  block,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm';
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  block?: boolean;
  ariaLabel?: string;
}) {
  const classes = [
    'btn',
    variant !== 'default' && `btn--${variant}`,
    size === 'sm' && 'btn--sm',
    block && 'btn--block',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="btn__spinner" /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------- Tabs */

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number;
}

export function Tabs({
  items,
  active,
  onChange,
  variant,
  label,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  variant?: 'rail';
  label: string;
}) {
  return (
    <div
      className={['tabs', variant === 'rail' && 'tabs--rail'].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="tab"
          id={`tab-${item.id}`}
          aria-selected={active === item.id}
          aria-controls={`tabpanel-${item.id}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined ? <span className="tab__count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- states */

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" />
      <p className="state__text">{label}</p>
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack stack--tight" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 34, opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="state">
      {icon ?? <IconInfo className="state__icon" size={28} />}
      <p className="state__title">{title}</p>
      {children ? <div className="state__text">{children}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: { message: string; code?: string; status?: number; details?: Record<string, unknown> } | null;
  onRetry?: () => void;
}) {
  return (
    <div className="state state--error" role="alert">
      <IconAlert className="state__icon" size={28} />
      <p className="state__title">{title}</p>
      <p className="state__text">{error?.message ?? 'The backend did not return a usable response.'}</p>
      {error && (error.code || error.status) ? (
        <pre className="state__detail">
          {[error.status ? `HTTP ${error.status}` : null, error.code ? `code: ${error.code}` : null]
            .filter(Boolean)
            .join('  ·  ')}
          {error.details && Object.keys(error.details).length > 0
            ? `\n${JSON.stringify(error.details, null, 2)}`
            : ''}
        </pre>
      ) : null}
      {onRetry ? (
        <Button onClick={onRetry} size="sm">
          <IconRefresh size={13} /> Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
  icon,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
  icon?: ReactNode;
}) {
  const defaultIcon = tone === 'critical' || tone === 'warning' ? <IconAlert size={16} /> : <IconInfo size={16} />;
  return (
    <div className={`callout callout--${tone}`}>
      <span className="callout__icon">{icon ?? defaultIcon}</span>
      <div className="callout__body">
        {title ? <span className="callout__title">{title}</span> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- meter */

export function Meter({
  value,
  label,
  tone = 'brand',
  showValue = true,
}: {
  value: number | null | undefined;
  label?: string;
  tone?: Tone | 'brand';
  showValue?: boolean;
}) {
  const pct = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value)) * 100;
  const fillTone = tone === 'brand' ? '' : `meter__fill--${tone}`;
  return (
    <div className="meter" title={label ? `${label}: ${formatPercent(value)}` : undefined}>
      <div
        className="meter__track"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Confidence'}
      >
        <div className={`meter__fill ${fillTone}`} style={{ width: `${pct}%` }} />
      </div>
      {showValue ? <span className="meter__value">{formatPercent(value)}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ key/value */

export function KeyValue({ rows }: { rows: Array<{ k: ReactNode; v: ReactNode }> }) {
  return (
    <dl className="kv">
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt className="kv__k">{row.k}</dt>
          <dd className="kv__v">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: 'critical' | 'warning' | 'ok' | 'info';
  title?: string;
}) {
  return (
    <div className={['stat', tone && `stat--${tone}`].filter(Boolean).join(' ')} title={title}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ disclosure */

export function Disclosure({
  summary,
  children,
  count,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  count?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className="stack stack--tight">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        style={{ justifyContent: 'flex-start' }}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none' }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 1.4 6.6 5 3 8.6" />
          </svg>
        </span>
        {summary}
        {count !== undefined ? <span className="tab__count">{count}</span> : null}
      </button>
      {open ? (
        <div id={id} className="stack stack--tight" style={{ paddingLeft: 'var(--sp-4)' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Verbatim text with a subtle "this is simulated" affordance. */
export function SimulatedTag({ simulated }: { simulated: boolean }) {
  if (!simulated) return <Badge tone="ok">Live record</Badge>;
  return (
    <Badge tone="warning" title="This record comes from the deterministic fixture dataset, not a live Slack/ticketing integration.">
      Simulated source
    </Badge>
  );
}

export function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onClick} aria-label={label} title={label}>
      <IconClose size={13} />
    </button>
  );
}
