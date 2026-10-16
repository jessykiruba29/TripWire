/**
 * Graph assembly. Turns the deterministic entity records + source corpus into the
 * node/edge structure served by GET /api/graph.
 *
 * Pure and deterministic: calling buildDataset() twice yields deep-equal output.
 */

import { CORE_SOURCES } from './sources-core.js';
import { BULK_SOURCES } from './sources-bulk.js';
import {
  TEAMS, PEOPLE, SYSTEMS, PROJECTS, DECISIONS, ASSUMPTIONS, FACTS, EVENTS,
  SEEDED_AT, DEMO_CLOCK, STORYLINE,
} from './dataset-entities.js';

export const SOURCE_NODE_TYPE = {
  slack_message: 'message',
  ticket: 'document',
  prd: 'document',
  meeting_note: 'document',
};

export function sourceNodeType(type) {
  return SOURCE_NODE_TYPE[type] || 'document';
}

export function edgeId(source, type, target) {
  return `E-${source}__${type}__${target}`;
}

function node(id, type, label, props = {}) {
  return {
    id,
    type,
    label,
    state: props.state || 'normal',
    summary: props.summary || '',
    confidence: props.confidence ?? null,
    project_ids: props.project_ids || [],
    team_ids: props.team_ids || [],
    valid_from: props.valid_from ?? null,
    valid_to: props.valid_to ?? null,
    recorded_at: props.recorded_at ?? null,
    degree: 0,
    source_ids: props.source_ids || [],
    properties: props.properties || {},
  };
}

export function buildDataset() {
  const nodes = [];
  const edges = [];
  const edgeSeen = new Set();

  const pushEdge = (source, target, type, extra = {}) => {
    if (!source || !target || source === target) return;
    const id = extra.id || edgeId(source, type, target);
    if (edgeSeen.has(id)) return;
    edgeSeen.add(id);
    edges.push({
      id,
      source,
      target,
      type,
      label: extra.label || type.replace(/_/g, ' '),
      confidence: extra.confidence ?? null,
      properties: extra.properties || {},
    });
  };

  // --- sources ---------------------------------------------------------------
  const sources = [...CORE_SOURCES, ...BULK_SOURCES]
    .map((s) => ({ ...s, simulated: true, metadata: s.metadata || {} }))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1));

  const sourcesByEntity = new Map();
  const sourcesByFact = new Map();
  const sourcesByAuthor = new Map();
  for (const s of sources) {
    for (const e of s.entity_ids || []) {
      if (!sourcesByEntity.has(e)) sourcesByEntity.set(e, []);
      sourcesByEntity.get(e).push(s.id);
    }
    for (const f of s.fact_ids || []) {
      if (!sourcesByFact.has(f)) sourcesByFact.set(f, []);
      sourcesByFact.get(f).push(s.id);
    }
    if (!sourcesByAuthor.has(s.author_id)) sourcesByAuthor.set(s.author_id, []);
    sourcesByAuthor.get(s.author_id).push(s.id);
  }

  // --- teams, people --------------------------------------------------------
  for (const t of TEAMS) {
    nodes.push(node(t.id, 'team', t.name, {
      summary: t.focus,
      project_ids: PROJECTS.filter((p) => p.team_id === t.id).map((p) => p.id),
      properties: { focus: t.focus },
    }));
  }
  for (const p of PEOPLE) {
    nodes.push(node(p.id, 'person', p.name, {
      summary: `${p.title} · ${TEAMS.find((t) => t.id === p.team_id)?.name || 'Unknown team'}`,
      team_ids: [p.team_id],
      project_ids: PROJECTS.filter((pr) => pr.team_id === p.team_id).map((pr) => pr.id),
      source_ids: sourcesByAuthor.get(p.id) || [],
      properties: {
        title: p.title, team_id: p.team_id, blurb: p.blurb, joined: p.joined,
        official_owner_of: p.official_owner_of, source_count: (sourcesByAuthor.get(p.id) || []).length,
      },
    }));
    pushEdge(p.id, p.team_id, 'member_of');
  }

  // --- systems --------------------------------------------------------------
  for (const s of SYSTEMS) {
    nodes.push(node(s.id, 'system', s.title, {
      summary: s.blurb,
      team_ids: [PEOPLE.find((p) => p.id === s.owner_id)?.team_id].filter(Boolean),
      project_ids: PROJECTS.filter((pr) => pr.system_ids.includes(s.id)).map((pr) => pr.id),
      source_ids: sourcesByEntity.get(s.id) || [],
      properties: { owner_id: s.owner_id, criticality: s.criticality, blurb: s.blurb },
    }));
    if (s.owner_id) pushEdge(s.owner_id, s.id, 'owns');
  }

  // --- projects -------------------------------------------------------------
  for (const p of PROJECTS) {
    nodes.push(node(p.id, 'project', p.title, {
      summary: p.blurb,
      team_ids: [p.team_id],
      project_ids: [p.id],
      source_ids: sourcesByEntity.get(p.id) || [],
      properties: { status: p.status, team_id: p.team_id, blurb: p.blurb },
    }));
    pushEdge(p.id, p.team_id, 'part_of');
    for (const sys of p.system_ids) pushEdge(p.id, sys, 'uses');
    for (const a of p.assumption_ids) pushEdge(p.id, a, 'assumes');
    for (const d of p.decision_ids) pushEdge(d, p.id, 'affects');
  }

  // --- assumptions ----------------------------------------------------------
  for (const a of ASSUMPTIONS) {
    nodes.push(node(a.id, 'assumption', a.label, {
      summary: a.statement,
      project_ids: PROJECTS.filter((p) => p.assumption_ids.includes(a.id)).map((p) => p.id),
      source_ids: sourcesByEntity.get(a.id) || [],
      confidence: 0.8,
      properties: {
        statement: a.statement, status: 'supported',
        supported_by: a.supported_by.slice(), contradicted_by: [],
        decision_ids: a.decision_ids.slice(),
      },
    }));
    for (const f of a.supported_by) pushEdge(f, a.id, 'supports', { confidence: 0.85 });
  }

  // --- decisions ------------------------------------------------------------
  for (const d of DECISIONS) {
    nodes.push(node(d.id, 'decision', d.title, {
      summary: d.description,
      project_ids: d.project_ids.slice(),
      system_ids: d.system_ids.slice(),
      recorded_at: d.created_at,
      source_ids: d.created_from ? [d.created_from] : [],
      confidence: 0.9,
      properties: {
        status: 'active', owner_id: d.owner_id, created_at: d.created_at,
        impact_weight: d.impact_weight, description: d.description,
        assumption_ids: d.depends_on.slice(), created_from: d.created_from,
        review_state: 'none',
      },
    }));
    if (d.owner_id) pushEdge(d.owner_id, d.id, 'owns_decision');
    for (const a of d.depends_on) pushEdge(d.id, a, 'depends_on', { confidence: 0.8 });
    for (const sys of d.system_ids) pushEdge(d.id, sys, 'affects');
  }

  // --- facts ----------------------------------------------------------------
  for (const f of FACTS) {
    nodes.push(node(f.id, 'fact', f.statement.length > 74 ? `${f.statement.slice(0, 71)}...` : f.statement, {
      summary: f.statement,
      project_ids: f.project_ids.slice(),
      source_ids: f.extracted_from ? [f.extracted_from] : (sourcesByFact.get(f.id) || []),
      valid_from: f.valid_from,
      valid_to: f.valid_to,
      recorded_at: f.recorded_at,
      confidence: f.confidence,
      properties: { statement: f.statement, kind: f.kind, extracted_from: f.extracted_from, superseded_at: null },
    }));
    for (const a of f.supports) pushEdge(f.id, a, 'supports', { confidence: f.confidence });
    if (f.extracted_from) pushEdge(f.id, f.extracted_from, 'documented_in');
  }

  // --- sources as graph nodes ----------------------------------------------
  for (const s of sources) {
    nodes.push(node(s.id, sourceNodeType(s.type), s.title, {
      summary: s.text.length > 160 ? `${s.text.slice(0, 157)}...` : s.text,
      recorded_at: s.recorded_at,
      project_ids: (s.entity_ids || []).filter((e) => e.startsWith('PRJ-')),
      source_ids: [s.id],
      confidence: null,
      properties: {
        source_type: s.type, author_id: s.author_id, timestamp: s.timestamp,
        external_id: s.external_id, simulated: true,
        excerpt: s.text.length > 240 ? `${s.text.slice(0, 237)}...` : s.text,
        metadata: s.metadata || {},
      },
    }));
    pushEdge(s.author_id, s.id, 'author_of');
    for (const e of s.entity_ids || []) pushEdge(s.id, e, 'about');
  }

  // --- derived expertise edges ---------------------------------------------
  const contribution = new Map();
  for (const s of sources) {
    for (const e of s.entity_ids || []) {
      if (!e.startsWith('SYS-') && !e.startsWith('PRJ-')) continue;
      const key = `${s.author_id}|${e}`;
      contribution.set(key, (contribution.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of [...contribution.entries()].sort()) {
    const [personId, entityId] = key.split('|');
    pushEdge(personId, entityId, 'contributes_to', { properties: { source_count: count } });
  }

  // --- events ---------------------------------------------------------------
  for (const e of EVENTS) {
    nodes.push(node(e.id, 'event', e.summary, {
      summary: e.summary,
      recorded_at: e.recorded_at,
      source_ids: e.source_id ? [e.source_id] : [],
      properties: {
        event_type: e.type, actor: e.actor, occurred_at: e.occurred_at,
        raw_text: e.raw_text, source_id: e.source_id, fact_ids: (e.fact_ids || []).slice(),
      },
    }));
    for (const f of e.fact_ids || []) pushEdge(e.id, f, 'raised_for');
    if (e.source_id) pushEdge(e.id, e.source_id, 'observed_by');
  }

  // --- degree ---------------------------------------------------------------
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  return {
    seeded_at: SEEDED_AT,
    demo_clock: DEMO_CLOCK,
    storyline: { ...STORYLINE },
    nodes,
    edges,
    sources,
    events: EVENTS.map((e) => ({ ...e, fact_ids: (e.fact_ids || []).slice() })),
    counts: {
      people: PEOPLE.length,
      teams: TEAMS.length,
      systems: SYSTEMS.length,
      projects: PROJECTS.length,
      decisions: DECISIONS.length,
      assumptions: ASSUMPTIONS.length,
      facts: FACTS.length,
      sources: sources.length,
      events: EVENTS.length,
      alerts: 0,
    },
    source_counts_by_type: sources.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {}),
  };
}
