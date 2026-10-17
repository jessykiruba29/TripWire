/**
 * Tripwire router.
 *
 * A deliberately tiny hash router: deep links (`#/graph`), working browser
 * back/forward, and no server rewrite rules required, so the same build works
 * from `vite dev`, `vite preview`, and any static file host.
 *
 * Routes are declared once in `ROUTES`; the sidebar, the page titles and the
 * breadcrumb trail all read from that single registry.
 */

import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  IconAlert,
  IconBolt,
  IconDoc,
  IconHistory,
  IconNetwork,
  IconSpark,
  IconTarget,
  IconUser,
} from './components/common/Icons';

export interface RouteDef {
  /** Hash path, e.g. `/graph`. */
  path: string;
  /** Sidebar label. */
  label: string;
  /** Document/page title. */
  title: string;
  /** One-line description rendered as the page subtitle. */
  blurb: string;
  /** Sidebar icon component (accepts a `size` prop). */
  icon: ComponentType<{ size?: number }>;
  /** Short breadcrumb shown on the page header. */
  crumb: string;
}

/**
 * The landing page is not part of the application shell: it owns `/` and renders
 * full-bleed, with no sidebar, no breadcrumb and no page header.  Everything else
 * lives inside the shell, which is why the Command Center moved to `/command`.
 */
export const LANDING_ROUTE: RouteDef = {
  path: '/',
  label: 'Home',
  crumb: 'Home',
  title: 'Tripwire',
  blurb: '',
  icon: IconSpark,
};

export const ROUTES: RouteDef[] = [
  {
    path: '/command',
    label: 'Command Center',
    crumb: 'Overview',
    title: 'Command Center',
    blurb: '',
    icon: IconSpark,
  },
  {
    path: '/graph',
    label: 'Knowledge Graph',
    crumb: 'Graph',
    title: 'Knowledge Graph',
    blurb: 'Explore entities and the directed relationships between them.',
    icon: IconNetwork,
  },
  {
    path: '/decisions',
    label: 'Decision Explorer',
    crumb: 'Decisions',
    title: 'Decision Explorer',
    blurb: 'Decisions with their assumptions, evidence, dependencies and downstream impact.',
    icon: IconTarget,
  },
  {
    path: '/scenarios',
    label: 'Scenario Lab',
    crumb: 'Scenarios',
    title: 'Scenario Lab',
    blurb: 'Change one fact and watch propagation, alerts and impact as the backend computes them.',
    icon: IconBolt,
  },
  {
    path: '/evidence',
    label: 'Evidence & Provenance',
    crumb: 'Evidence',
    title: 'Evidence & Provenance',
    blurb: 'Source records, provenance chains and both time axes, kept apart.',
    icon: IconDoc,
  },
  {
    path: '/experts',
    label: 'Expert Intelligence',
    crumb: 'Experts',
    title: 'Expert Intelligence',
    blurb: 'Who actually did the work — ranked by recorded contribution, not the org chart.',
    icon: IconUser,
  },
  {
    path: '/alerts',
    label: 'Alerts & Review',
    crumb: 'Alerts',
    title: 'Alerts & Review',
    blurb: 'Alert evidence, legal transitions and reviews that persist on the server.',
    icon: IconAlert,
  },
  {
    path: '/history',
    label: 'History & Activity',
    crumb: 'History',
    title: 'History & Activity',
    blurb: 'Chronological events, belief snapshots and what the company learned when.',
    icon: IconHistory,
  },
];

export const DEFAULT_ROUTE = ROUTES[0];

/** The current hash path (`#/graph` → `/graph`). */
export function currentPath(): string {
  if (typeof window === 'undefined') return '/';
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function matchRoute(path: string): RouteDef {
  if (path === '/' || path === '') return LANDING_ROUTE;
  const exact = ROUTES.find((route) => route.path === path);
  if (exact) return exact;
  // Unknown hashes fall back to the Command Center rather than a blank screen.
  return DEFAULT_ROUTE;
}

export function routeFor(path: string): RouteDef {
  return matchRoute(path);
}

/** Navigate to a hash route. Same-path clicks are no-ops. */
export function navigate(path: string): void {
  const target = path.startsWith('#') ? path.slice(1) : path;
  const normalized = target.startsWith('/') ? target : `/${target}`;
  if (currentPath() === normalized) return;
  window.location.hash = normalized;
}

/** Subscribe to hash changes (adds/removes the listener correctly under StrictMode). */
export function useRoute(): RouteDef {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const route = matchRoute(path);

  useEffect(() => {
    document.title = `${route.title} · Tripwire`;
    // Route changes represent navigation, not animation: park the scroll at the
    // top of the new page the way a real multi-page app would.
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [route.path, route.title]);

  return route;
}

export interface LinkProps {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  'aria-label'?: string;
  'aria-current'?: 'page' | undefined;
  onClick?: () => void;
}

/** Anchor that navigates without a full page load (still a real `href` for a11y). */
export function Link({ to, children, ...rest }: LinkProps) {
  const normalized = to.startsWith('/') ? to : `/${to}`;
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle new-tab/new-window and download clicks.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      rest.onClick?.();
      navigate(normalized);
    },
    [normalized, rest],
  );

  return (
    <a href={`#${normalized}`} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
