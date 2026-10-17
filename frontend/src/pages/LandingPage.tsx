/**
 * Tripwire landing page — the entry point, before the application shell.
 *
 * Deliberately almost wordless. The job of this page is to make the product's
 * single idea visible in about four seconds:
 *
 *     decisions rest on assumptions, assumptions rest on facts, facts change.
 *
 * The orbit diagram is the whole story: one decision, one assumption, two facts -
 * one of which has just contradicted the other - and the wire that trips.  Copy is
 * kept to a headline, one line of support and two actions; every extra sentence
 * pushed the actual product further down the page.
 */

import { useMemo, type ReactNode } from 'react';
import { TripwireMark } from '../components/layout/AppHeader';
import { Link } from '../router';
import type { ShellContext } from '../App';
import '../styles/landing.css';

/** A decision → assumption → fact chain, ending in a contradiction. */
function OrbitDiagram(): ReactNode {
  return (
    <div className="orbit" aria-hidden="true">
      <svg className="orbit__svg" viewBox="0 0 520 460" role="presentation">
        <defs>
          <linearGradient id="orbit-wire" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent-violet)" stopOpacity="0.55" />
          </linearGradient>
          <radialGradient id="orbit-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent-violet)" stopOpacity="0.55" />
            <stop offset="70%" stopColor="var(--accent-violet)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--accent-violet)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* orbital rings */}
        <circle className="orbit__ring" cx="260" cy="210" r="96" />
        <circle className="orbit__ring orbit__ring--wide" cx="260" cy="210" r="150" />
        <circle cx="260" cy="210" r="150" fill="url(#orbit-core)" opacity="0.5" />

        {/* the dependency wire: decision -> assumption -> fact */}
        <path className="orbit__wire" d="M260 96 L260 176" />
        <path className="orbit__wire" d="M244 236 L188 300" />
        <path className="orbit__wire" d="M276 236 L332 300" />

        {/* decision */}
        <g className="orbit__node orbit__node--decision">
          <circle cx="260" cy="88" r="9" />
          <text x="260" y="60" textAnchor="middle">DECISION</text>
        </g>

        {/* assumption */}
        <g className="orbit__node orbit__node--assumption">
          <circle cx="260" cy="206" r="7" />
          <text x="260" y="188" textAnchor="middle">ASSUMPTION</text>
        </g>

        {/* the fact that still holds */}
        <g className="orbit__node orbit__node--fact">
          <circle cx="182" cy="308" r="6" />
          <text x="146" y="336" textAnchor="middle">FACT</text>
        </g>

        {/* the fact that was just contradicted */}
        <g className="orbit__node orbit__node--stale">
          <circle cx="338" cy="308" r="6" />
          <circle className="orbit__pulse" cx="338" cy="308" r="6" />
          <text x="376" y="336" textAnchor="middle">CONTRADICTED</text>
        </g>

        {/* the tripwire */}
        <path className="orbit__trip" d="M276 236 L332 300" />
      </svg>
    </div>
  );
}

export function LandingPage({ ctx }: { ctx: ShellContext }): ReactNode {
  const { tw } = ctx;

  const entities = tw.health.data?.counts.nodes ?? tw.graph.data?.nodes.length ?? 0;
  const alerts = tw.alerts.data?.total ?? 0;
  const atRisk = tw.affectedDecisions.length;

  const modeLabel = useMemo(() => {
    if (!tw.connection) return 'connecting';
    return tw.isMock ? 'reference engine' : 'live backend';
  }, [tw.connection, tw.isMock]);

  return (
    <div className="landing">
      <header className="landing__bar">
        <div className="landing__brand">
          <TripwireMark size={22} />
          <span className="landing__wordmark">Tripwire</span>
        </div>
        <span className={`landing__mode landing__mode--${tw.isMock ? 'mock' : 'live'}`}>
          <span className="landing__mode-dot" aria-hidden="true" />
          {modeLabel}
        </span>
      </header>

      <main className="landing__main">
        <section className="landing__hero">
          <p className="landing__eyebrow">Decision provenance intelligence</p>

          <h1 className="landing__headline">
            Know when the <span className="landing__accent">ground</span> moves.
          </h1>

          <p className="landing__lede">
            Every decision rests on facts. Tripwire remembers which ones.
          </p>

          <div className="landing__actions">
            <Link to="/command" className="landing__cta">
              Enter Tripwire
              <span className="landing__cta-arrow" aria-hidden="true">
                →
              </span>
            </Link>
            <Link to="/scenarios" className="landing__cta landing__cta--ghost">
              Run the Frankfurt scenario
            </Link>
          </div>

          <dl className="landing__stats">
            <div className="landing__stat">
              <dt>Entities</dt>
              <dd>{entities}</dd>
            </div>
            <div className="landing__stat">
              <dt>Decisions at risk</dt>
              <dd>{atRisk}</dd>
            </div>
            <div className="landing__stat">
              <dt>Open alerts</dt>
              <dd>{alerts}</dd>
            </div>
          </dl>
        </section>

        <section className="landing__visual">
          <OrbitDiagram />
          <p className="landing__caption">
            One fact changed. The path to every decision it supported is preserved.
          </p>
        </section>
      </main>

      <section className="landing__features" aria-label="What Tripwire does">
        {[
          { title: 'One graph', text: 'Facts, assumptions, decisions and people in a single constellation.' },
          { title: 'Live provenance', text: 'Every claim traced back to the message it came from.' },
          { title: 'Honest alerts', text: 'Impact, uncertainty and evidence — never a verdict.' },
        ].map((feature) => (
          <article key={feature.title} className="landing__feature">
            <h2 className="landing__feature-title">{feature.title}</h2>
            <p className="landing__feature-text">{feature.text}</p>
          </article>
        ))}
      </section>

      <footer className="landing__foot">
        <span>Northwind Labs reference dataset</span>
        <span className="landing__foot-sep" aria-hidden="true">
          ·
        </span>
        <span>Deterministic · offline-capable · explainable</span>
      </footer>
    </div>
  );
}
