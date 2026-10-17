/**
 * Legend. Doubles as the graph filter control: clicking a type toggles it, so the
 * thing that explains the graph is also the thing that shapes it.
 */

import type { NodeType } from '../../api/types';
import { NODE_TYPE_META, NODE_STATE_META } from '../../lib/vocabulary';
import { PRIMARY_EDGE_COLOR } from './graphTheme';

export interface GraphLegendProps {
  counts: Map<NodeType, number>;
  activeTypes: NodeType[];
  onToggleType: (type: NodeType) => void;
}

const ATTENTION_STATES: Array<{ state: keyof typeof NODE_STATE_META; ring: string; dashed?: boolean }> = [
  { state: 'contradicted', ring: '#ff6b5e', dashed: true },
  { state: 'new_fact', ring: '#6fd7f2' },
  { state: 'needs_review', ring: '#f6b95a' },
  { state: 'confirmed_stale', ring: '#ff6b5e' },
  { state: 'potentially_affected', ring: '#f6b95a', dashed: true },
];

const RELATION_SAMPLES: Array<{ key: keyof typeof PRIMARY_EDGE_COLOR; label: string; dashed?: boolean }> = [
  { key: 'contradicts', label: 'contradicts', dashed: true },
  { key: 'supports', label: 'supports' },
  { key: 'depends_on', label: 'depends on' },
  { key: 'affects', label: 'affects' },
];

export function GraphLegend({ counts, activeTypes, onToggleType }: GraphLegendProps) {
  const present = (Object.keys(NODE_TYPE_META) as NodeType[]).filter((type) => (counts.get(type) ?? 0) > 0);

  return (
    <div className="legend" data-testid="graph-legend">
      <div className="legend__group" style={{ flex: '1 1 320px' }}>
        <span className="legend__title">Entities — click to show or hide</span>
        <div className="legend__items">
          {present.map((type) => {
            const meta = NODE_TYPE_META[type];
            const active = activeTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                className="legend__item"
                aria-pressed={active}
                onClick={() => onToggleType(type)}
                title={meta.description}
              >
                <span
                  className={`legend__swatch legend__swatch--${meta.shape}`}
                  style={{ background: meta.hex }}
                  aria-hidden="true"
                />
                {meta.label}
                <span className="legend__count">{counts.get(type) ?? 0}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="legend__group" style={{ flex: '1 1 220px' }}>
        <span className="legend__title">Needs attention — ring on the node</span>
        <div className="legend__items">
          {ATTENTION_STATES.map(({ state, ring, dashed }) => (
            <span key={state} className="legend__item" title={NODE_STATE_META[state].description}>
              <span
                className="legend__ring"
                style={{ borderColor: ring, borderStyle: dashed ? 'dashed' : 'solid' }}
                aria-hidden="true"
              />
              {NODE_STATE_META[state].label}
            </span>
          ))}
        </div>
      </div>

      <div className="legend__group" style={{ flex: '1 1 200px' }}>
        <span className="legend__title">Decisive relationships</span>
        <div className="legend__items">
          {RELATION_SAMPLES.map(({ key, label, dashed }) => (
            <span key={String(key)} className="legend__item">
              <svg width="18" height="8" aria-hidden="true">
                <line
                  x1="0"
                  y1="4"
                  x2="18"
                  y2="4"
                  stroke={PRIMARY_EDGE_COLOR[key]}
                  strokeWidth="2"
                  strokeDasharray={dashed ? '3 2' : undefined}
                />
              </svg>
              {label}
            </span>
          ))}
          <span className="legend__item muted">Faint grey lines are provenance and org structure</span>
        </div>
      </div>
    </div>
  );
}
