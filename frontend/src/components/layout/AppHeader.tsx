/**
 * Application chrome: identity, runtime mode, and the two demo actions.
 *
 * The runtime mode is deliberately loud. A fixture dataset must never be able to
 * pass as a live company system, so `health.mode` is printed verbatim here and the
 * banner repeats it whenever the app is not talking to a real backend.
 */

import type { ApiConnection } from '../../api';
import type { HealthResponse } from '../../api/types';
import { Button } from '../common';
import { IconRefresh } from '../common/Icons';
import './layout.css';

export function TripwireMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Tripwire">
      <defs>
        <linearGradient id="tripwire-mark" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#a68dff" />
          <stop offset="1" stopColor="#59d9ff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#10142b" stroke="#6659aa" />
      <path d="M8 10.5 16 16l8-6M8 21.5 16 16l8 5.5" fill="none" stroke="url(#tripwire-mark)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="10.5" r="2.3" fill="#d4c8ff" />
      <circle cx="8" cy="21.5" r="2.3" fill="#91e8ff" />
      <circle cx="24" cy="10.5" r="2.3" fill="#91e8ff" />
      <circle cx="24" cy="21.5" r="2.3" fill="#d4c8ff" />
      <circle cx="16" cy="16" r="3" fill="#f2b8ff" stroke="#10142b" strokeWidth="1.2" />
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
          <TripwireMark size={28} />
          <div className="header__names">
            <div className="header__title">
              <span className="header__wordmark">Tripwire</span>
              <span className="header__version">{health?.version ? `v${health.version}` : ''}</span>
            </div>
          </div>
        </div>

        <div className="header__spacer" />

        <div className="header__actions">
        

          <Button onClick={onRunScenario} variant="primary">
            
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

      <ModeBanner connection={connection} />
    </header>
  );
}

export function ModeBanner({ connection }: { connection: ApiConnection | null }) {
  if (!connection) return null;

  if (connection.resolvedMode === 'mock') {
    return (
      <div className="banner" role="status">
        <span className="banner__label">MOCK MODE</span>
        <span className="banner__text">Reference data · connect a live backend for production records.</span>
        {connection.probeError ? (
          <span className="banner__meta" title={connection.probeError.message}>
            {connection.probeError.code}
          </span>
        ) : null}
      </div>
    );
  }

 

  return null;
}
