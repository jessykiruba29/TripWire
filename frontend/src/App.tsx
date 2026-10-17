/**
 * Tripwire application shell.
 *
 * The single-page dashboard is gone: every capability now owns a real route
 * (`#/graph`, `#/decisions`, …) rendered inside one navigation shell with
 * active-route indicators, page titles and breadcrumbs.  The shell owns the
 * connection state (boot / fatal / mode banner), the global callouts and the
 * cross-page navigation vocabulary; each page composes the existing, tested
 * panels rather than reimplementing them.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { indexNodes } from './lib/graph';
import { useTripwire, type Tripwire } from './state/useTripwire';
import { Callout, ErrorState } from './components/common';
import { AppHeader, TripwireMark } from './components/layout/AppHeader';
import { Link, ROUTES, useRoute, type RouteDef } from './router';
import { CommandCenterPage } from './pages/CommandCenterPage';
import { LandingPage } from './pages/LandingPage';
import './styles/pages.css';
import { GraphPage } from './pages/GraphPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { ScenarioLabPage, type StoryStepId } from './pages/ScenarioLabPage';
import { EvidencePage } from './pages/EvidencePage';
import { ExpertsPage } from './pages/ExpertsPage';
import { AlertsPage } from './pages/AlertsPage';
import { HistoryPage } from './pages/HistoryPage';
import './styles/app.css';
import './styles/shell.css';
import './styles/pages-redesign.css';
//import './styles/layout-final.css';

/** Navigation + cross-page actions shared by every page. */
export interface ShellContext {
  tw: Tripwire;
  nodeIndex: ReturnType<typeof indexNodes>;
  route: RouteDef;
  /** Select a node and open the graph page's inspector for it. */
  inspectNode: (id: string | null) => void;
  /** Explain a decision on the Decision Explorer page. */
  explainDecision: (id: string) => void;
  /** Open a source record on the Evidence page. */
  openSource: (id: string) => void;
  /** Pick an evidence/inspector tab target and go there. */
  goto: (path: string) => void;
  /** Story-step deep links from the Scenario Lab. */
  onStep: (step: StoryStepId) => void;
}

export function App() {
  const tw = useTripwire();
  const route = useRoute();
  const [reloadBusy, setReloadBusy] = useState(false);

  const nodeIndex = useMemo(() => indexNodes(tw.graph.data?.nodes ?? []), [tw.graph.data]);

  // The shell's <main> is the scrolling box, so a route change must reset IT,
  // not window — otherwise every navigation inherits the previous page's scroll
  // offset and the page head lands off-screen.
  useEffect(() => {
    document.querySelector('.shell__main')?.scrollTo({ top: 0, behavior: 'auto' });
  }, [route.path]);

  /* ------------------------------------------------------------- actions */

  const goto = useCallback((path: string) => {
    window.location.hash = path.startsWith('/') ? path : `/${path}`;
  }, []);

  const inspectNode = useCallback(
    (id: string | null) => {
      tw.selectNode(id);
      if (id && route.path !== '/graph') goto('/graph');
    },
    [tw, route.path, goto],
  );

  const explainDecision = useCallback(
    (decisionId: string) => {
      void tw.showExplanation(decisionId);
      if (route.path !== '/decisions') goto('/decisions');
    },
    [tw, route.path, goto],
  );

  const openSource = useCallback(
    (sourceId: string) => {
      tw.openSource(sourceId);
      if (route.path !== '/evidence') goto('/evidence');
    },
    [tw, route.path, goto],
  );

  const handleRunScenario = useCallback(async () => {
    const text = tw.demoState.data?.storyline.trigger_text ?? '';
    if (route.path !== '/scenarios') goto('/scenarios');
    await tw.triggerDemo({
      scenario: tw.scenario ?? undefined,
      text: text || undefined,
      channel: 'slack',
    });
  }, [tw, route.path, goto]);

  const handleReset = useCallback(async () => {
    await tw.resetDemo();
  }, [tw]);

  const handleReload = useCallback(async () => {
    setReloadBusy(true);
    tw.reloadAll();
    await new Promise((resolve) => setTimeout(resolve, 350));
    setReloadBusy(false);
  }, [tw]);

  /** Story-step buttons deep-link into the page that owns each step. */
  const handleStep = useCallback(
    (step: StoryStepId) => {
      switch (step) {
        case 'event': {
          const sourceId = tw.lastTrigger?.source?.id ?? tw.lastTrigger?.event.source_id;
          if (sourceId) openSource(sourceId);
          break;
        }
        case 'contradiction': {
          const factId = tw.lastTrigger?.extraction?.contradicted_fact?.id;
          if (factId) {
            tw.selectNode(factId);
            goto('/evidence');
          }
          break;
        }
        case 'propagation':
        case 'path': {
          goto('/graph');
          break;
        }
        case 'review': {
          const decisionId =
            tw.lastTrigger?.propagation.decisions[0]?.id ?? tw.demoState.data?.storyline.decision_id;
          if (decisionId) void tw.showExplanation(decisionId);
          goto('/decisions');
          break;
        }
        case 'expert': {
          goto('/experts');
          break;
        }
        case 'history': {
          goto('/history');
          break;
        }
      }
    },
    [tw, openSource, goto],
  );

  /* ---------------------------------------------------------------- boot */

  if (tw.connecting) {
    return (
      <div className="boot">
        <div className="boot__mark">
          <TripwireMark size={38} />
          <span className="boot__title">Tripwire</span>
        </div>
        <div className="loading-row">
          <span className="spinner" />
          <span>Resolving the backend connection…</span>
        </div>
      </div>
    );
  }

  if (tw.fatalError) {
    return (
      <div className="boot">
        <div className="boot__mark">
          <TripwireMark size={38} />
          <span className="boot__title">Tripwire</span>
        </div>
        <p className="boot__text">
          {tw.connection?.reason ??
            'Tripwire could not reach a backend and could not fall back to the in-browser reference engine.'}
        </p>
        <ErrorState
          title="No data source available"
          error={tw.fatalError}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const ctx: ShellContext = {
    tw,
    nodeIndex,
    route,
    inspectNode,
    explainDecision,
    openSource,
    goto,
    onStep: handleStep,
  };

  // The landing page owns "/" and renders outside the shell: no sidebar, no
  // breadcrumb, no page header. It is the front door, not a dashboard.
  if (route.path === '/') {
    return <LandingPage ctx={ctx} />;
  }

  const alertCount = tw.alerts.data?.total ?? tw.alerts.data?.alerts.length ?? 0;

  const badgeFor = (path: string): number | null => {
    if (path === '/alerts') return alertCount || null;
    if (path === '/decisions') return tw.affectedDecisions.length || null;
    if (path === '/graph') return tw.graph.data?.nodes.length ?? null;
    return null;
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to the main content
      </a>

      <AppHeader
        health={tw.health.data}
        connection={tw.connection}
        onReload={handleReload}
        reloadBusy={reloadBusy}
        onRunScenario={() => void handleRunScenario()}
        onReset={() => void handleReset()}
        resetBusy={tw.resetBusy}
        scenarioApplied={Boolean(tw.lastTrigger)}
      />

      <div className="shell">
        <nav className="sidenav" aria-label="Primary">
          {/*
            Grouped navigation. Eight flat items read as an undifferentiated list;
            four short sections tell you what kind of task each page is for. Labels
            are single words, and there is no descriptive copy in the sidebar.
          */}
          {(
            [
              { label: 'Overview', paths: ['/command'] },
              { label: 'Investigate', paths: ['/graph', '/decisions', '/alerts'] },
              { label: 'Trust', paths: ['/evidence', '/experts', '/history'] },
              { label: 'Demo', paths: ['/scenarios'] },
            ] satisfies { label: string; paths: string[] }[]
          ).map((section) => {
            const items = ROUTES.filter((item) => section.paths.includes(item.path));
            if (!items.length) return null;
            return (
              <div key={section.label} className="sidenav__section">
                <p className="sidenav__section-label">{section.label}</p>
                <ul className="sidenav__list">
                  {items.map((item) => {
                    const active = item.path === route.path;
                    const badge = badgeFor(item.path);
                    return (
                      <li key={item.path}>
                        <Link
                          to={item.path}
                          className={`sidenav__item${active ? ' is-active' : ''}`}
                          aria-current={active ? 'page' : undefined}
                        >
                          <span className="sidenav__icon" aria-hidden="true">
                            <item.icon size={16} />
                          </span>
                          <span className="sidenav__label">{item.label}</span>
                          {badge !== null ? (
                            <span className="sidenav__badge" aria-hidden="true">
                              {badge}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          <div className="sidenav__foot">
            <span className={`mode-dot mode-dot--${tw.isMock ? 'mock' : 'live'}`} aria-hidden="true" />
            <span className="sidenav__foot-text">
              {tw.isMock ? 'Mock engine' : 'Live backend'}
              {tw.health.data ? ` · ${tw.health.data.counts.nodes} entities` : ''}
            </span>
          </div>
        </nav>

        <main className="shell__main" id="main" tabIndex={-1}>
          <header className="page-head">
            <nav className="page-head__crumbs" aria-label="Breadcrumb">
              <Link to="/" className="page-head__crumb">
                Tripwire
              </Link>
              <span className="page-head__sep" aria-hidden="true">
                /
              </span>
              <span className="page-head__crumb page-head__crumb--current" aria-current="page">
                {route.crumb}
              </span>
            </nav>
            {/* Title only. Every page used to carry a one-line subtitle as well;
                eight subtitles read as noise and pushed the actual content down. */}
            <div className="page-head__row">
              <div className="page-head__titles">
                <h1 className="page-head__title">{route.title}</h1>
              </div>
            </div>
          </header>

          <GlobalCallouts tw={tw} />

          <div className="page" key={route.path} data-testid={`page-${route.path === '/' ? 'home' : route.path.slice(1)}`}>
            {renderPage(route, ctx)}
          </div>
        </main>
      </div>
    </div>
  );
}

function GlobalCallouts({ tw }: { tw: Tripwire }): ReactNode {
  return (
    <>
      {tw.demoState.error ? (
        <Callout tone="warning" title="Demo state is unavailable">
          {tw.demoState.error.message} The graph and decisions below may be stale.
        </Callout>
      ) : null}

      {tw.emptyBackend ? (
        <Callout tone="warning" title="Graph is empty">
          <p>
            Run <span className="mono">POST /api/demo/seed</span> or press Reset.
          </p>
        </Callout>
      ) : null}

      {tw.seededOnBoot ? (
        <Callout tone="info" title="Dataset seeded on startup">
          The backend store was empty, so the Northwind Labs dataset was seeded before the graph was read.
        </Callout>
      ) : null}
    </>
  );
}

function renderPage(route: RouteDef, ctx: ShellContext): ReactNode {
  switch (route.path) {
    case '/graph':
      return <GraphPage ctx={ctx} />;
    case '/decisions':
      return <DecisionsPage ctx={ctx} />;
    case '/scenarios':
      return <ScenarioLabPage ctx={ctx} />;
    case '/evidence':
      return <EvidencePage ctx={ctx} />;
    case '/experts':
      return <ExpertsPage ctx={ctx} />;
    case '/alerts':
      return <AlertsPage ctx={ctx} />;
    case '/history':
      return <HistoryPage ctx={ctx} />;
    default:
      return <CommandCenterPage ctx={ctx} />;
  }
}
