/**
 * Application chrome: identity, runtime mode, and the two demo actions.
 *
 * The runtime mode is deliberately loud. A fixture dataset must never be able to
 * pass as a live company system, so `health.mode` is printed verbatim here and the
 * banner repeats it whenever the app is not talking to a real backend.
 */

import type { ApiConnection } from '../../api';
import type { HealthResponse } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { Badge, Button, Chip } from '../common';
import { IconBolt, IconRefresh } from '../common/Icons';
import './layout.css';

export function TripwireMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Tripwire">
      <rect width="32" height="32" rx="7" fill="#1f4bd8" />
      <path d="M5 16h6.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M20.5 16H27" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M11.5 16c0-3 2.2-5 4.5-5s4.5 2 4.5 5-2.2 5-4.5 5-4.5-2-4.5-5Z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
      />
      <circle cx="16" cy="16" r="2.1" fill="#fff" />
      <path d="M7 9.5 16 6l9 3.5" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7 22.5 16 26l9-3.5" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export interface AppHeaderProps {
  health: HealthResponse | null;
  connection: ApiConnection | null;
  onReload: () => void;
  reloadBusy: boolean;
  onRunScenario: () => void;
  onReset: () => void;
  resetBusy: boolean;
  scenarioApplied: boolean;
}

export function AppHeader({
  health,
  connection,
  onReload,
  reloadBusy,
  onRunScenario,
  onReset,
  resetBusy,
  scenarioApplied,
}: AppHeaderProps) {
  return (
    <header className="app__header">
      <div className="header">
        <div className="header__brand">
          <TripwireMark />
          <div className="header__names">
            <div className="header__title">
              <span className="header__wordmark">Tripwire</span>
              <span className="header__version">{health?.version ? `v${health.version}` : ''}</span>
            </div>
            <p className="header__tagline">
              Every decision keeps the assumptions it was made on. When new information breaks one, Tripwire shows what
              changed, what it reaches, and who has to look.
            </p>
          </div>
        </div>

        <div className="header__spacer" />

        <div className="header__actions">
          <div className="header__status">
            {connection ? (
              <Badge
                tone={connection.resolvedMode === 'mock' ? 'warning' : 'ok'}
                dot
                title={connection.reason}
              >
                {connection.resolvedMode === 'mock' ? 'Mock mode' : 'Live backend'}
              </Badge>
            ) : (
              <Badge tone="neutral">Connecting…</Badge>
            )}
            {health ? (
              <Chip title="Mode string reported by GET /api/health, shown verbatim">
                {health.mode}
              </Chip>
            ) : null}
            {health ? (
              <span className="tiny muted nowrap" title={`Health sampled ${formatDateTime(health.time)}`}>
                {health.counts.nodes} entities · {health.counts.edges} relationships
              </span>
            ) : null}
          </div>

          <Button onClick={onRunScenario} variant="primary">
            <IconBolt size={14} />
            {scenarioApplied ? 'Re-run scenario' : 'Run Frankfurt scenario'}
          </Button>
          <Button onClick={onReset} busy={resetBusy}>
            <IconRefresh size={14} />
            Reset
          </Button>
          <Button onClick={onReload} busy={reloadBusy} variant="ghost" title="Re-fetch every endpoint">
            Refresh data
          </Button>
        </div>
      </div>

      <ModeBanner connection={connection} health={health} />
    </header>
  );
}

export function ModeBanner({ connection, health }: { connection: ApiConnection | null; health: HealthResponse | null }) {
  if (!connection) return null;

  if (connection.resolvedMode === 'mock') {
    return (
      <div className="banner" role="status">
        <span className="banner__label">MOCK MODE</span>
        <span className="banner__text">
          {connection.reason} Every record is marked <strong>simulated</strong> and every payload comes from the same
          deterministic reference engine the API contract describes. Set{' '}
          <span className="mono">VITE_API_MODE=live</span> (or point{' '}
          <span className="mono">VITE_API_BASE_URL</span> at a running backend) to use real data.
        </span>
        {connection.probeError ? (
          <span className="banner__meta" title={connection.probeError.message}>
            {connection.probeError.code}
          </span>
        ) : null}
      </div>
    );
  }

  if (health && health.mode !== 'production' && health.mode !== 'live') {
    return (
      <div className="banner banner--info" role="status">
        <span className="banner__label">BACKEND MODE</span>
        <span className="banner__text">
          The backend reports <span className="mono">{health.mode}</span> for dataset{' '}
          <span className="mono">{health.dataset.name}</span>. Tripwire shows that string verbatim so fixture data can
          never be mistaken for a live company system.
        </span>
      </div>
    );
  }

  return null;
}
