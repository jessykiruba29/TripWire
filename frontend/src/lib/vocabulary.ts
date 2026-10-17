/**
 * The shared vocabulary of the product.
 *
 * Every label and colour that describes a graph concept lives here once, so DOM
 * panels and the canvas graph cannot drift apart. Hex values mirror the
 * `--nt-*` / signal tokens in `styles/tokens.css`.
 */

import type {
  AlertStatus,
  EdgeType,
  Impact,
  NodeState,
  NodeType,
  ProvenanceKind,
  Severity,
  SourceType,
} from '../api/types';

export type Tone = 'neutral' | 'info' | 'ok' | 'warning' | 'critical' | 'brand';

export interface NodeTypeMeta {
  type: NodeType;
  label: string;
  plural: string;
  /** Canvas colour — keep in sync with `--nt-*` tokens. */
  hex: string;
  /** Marker shape used on the canvas, so type is readable without colour. */
  shape: 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon' | 'star';
  /** Relative canvas size. */
  size: number;
  description: string;
}

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  fact: {
    type: 'fact',
    label: 'Fact',
    plural: 'Facts',
    hex: '#7aa2ff',
    shape: 'circle',
    size: 7,
    description: 'Something the company believed true, with a validity window and a source.',
  },
  assumption: {
    type: 'assumption',
    label: 'Assumption',
    plural: 'Assumptions',
    hex: '#b18cff',
    shape: 'diamond',
    size: 6.5,
    description: 'A belief a decision silently leans on. This is where risk hides.',
  },
  decision: {
    type: 'decision',
    label: 'Decision',
    plural: 'Decisions',
    hex: '#4fe3c1',
    shape: 'hexagon',
    size: 8,
    description: 'A committed choice by a named owner.',
  },
  project: {
    type: 'project',
    label: 'Project',
    plural: 'Projects',
    hex: '#f7b955',
    shape: 'square',
    size: 7,
    description: 'Workstream the decision belongs to.',
  },
  system: {
    type: 'system',
    label: 'System',
    plural: 'Systems',
    hex: '#9aa8c7',
    shape: 'square',
    size: 6,
    description: 'Infrastructure or platform the decision applies to.',
  },
  person: {
    type: 'person',
    label: 'Person',
    plural: 'People',
    hex: '#ff8fc0',
    shape: 'circle',
    size: 5.5,
    description: 'A colleague, with the contributions they demonstrably made.',
  },
  team: {
    type: 'team',
    label: 'Team',
    plural: 'Teams',
    hex: '#a6dc6a',
    shape: 'square',
    size: 6,
    description: 'Organisational unit.',
  },
  message: {
    type: 'message',
    label: 'Message',
    plural: 'Messages',
    hex: '#8b97b4',
    shape: 'circle',
    size: 3.5,
    description: 'Slack-style source message. Evidence, verbatim.',
  },
  document: {
    type: 'document',
    label: 'Document',
    plural: 'Documents',
    hex: '#5fd3ef',
    shape: 'triangle',
    size: 5,
    description: 'Ticket, PRD or meeting note.',
  },
  event: {
    type: 'event',
    label: 'Event',
    plural: 'Events',
    hex: '#ff8577',
    shape: 'star',
    size: 8,
    description: 'A recorded change in the world that moved the graph.',
  },
};

export interface NodeStateMeta {
  state: NodeState;
  label: string;
  tone: Tone;
  description: string;
  /** True for the two states the frontend computes for path inspection. */
  frontendComputed?: boolean;
}

export const NODE_STATE_META: Record<NodeState, NodeStateMeta> = {
  normal: { state: 'normal', label: 'Normal', tone: 'neutral', description: 'Nothing outstanding.' },
  new_fact: {
    state: 'new_fact',
    label: 'New fact',
    tone: 'info',
    description: 'Just introduced by a recorded event and not yet reviewed.',
  },
  contradicted: {
    state: 'contradicted',
    label: 'Contradicted',
    tone: 'critical',
    description: 'A newer fact contradicts this one; its validity window was closed.',
  },
  contradicted_replacement: {
    state: 'contradicted_replacement',
    label: 'Replacement fact',
    tone: 'info',
    description: 'The fact that contradicts an older one.',
  },
  potentially_affected: {
    state: 'potentially_affected',
    label: 'Potentially affected',
    tone: 'warning',
    description: 'Reached by a contradiction path, but below the review threshold.',
  },
  needs_review: {
    state: 'needs_review',
    label: 'Needs review',
    tone: 'warning',
    description: 'Flagged for a human to confirm whether it still holds.',
  },
  confirmed_stale: {
    state: 'confirmed_stale',
    label: 'Confirmed stale',
    tone: 'critical',
    description: 'A reviewer confirmed this no longer holds.',
  },
  dismissed: {
    state: 'dismissed',
    label: 'Dismissed',
    tone: 'neutral',
    description: 'A reviewer decided no action was needed.',
  },
  resolved: { state: 'resolved', label: 'Resolved', tone: 'ok', description: 'The issue was resolved.' },
  selected_path: {
    state: 'selected_path',
    label: 'On the inspected path',
    tone: 'brand',
    description: 'Part of the evidence chain currently being explained.',
    frontendComputed: true,
  },
  unrelated: {
    state: 'unrelated',
    label: 'Unrelated',
    tone: 'neutral',
    description: 'Outside the inspected chain.',
    frontendComputed: true,
  },
};

export interface EdgeTypeMeta {
  type: EdgeType;
  label: string;
  description: string;
  /** Edges carrying consequence get emphasis on the canvas. */
  weight: 'primary' | 'structural';
  directional?: boolean;
}

export const EDGE_TYPE_META: Record<EdgeType, EdgeTypeMeta> = {
  contradicts: { type: 'contradicts', label: 'contradicts', description: 'The new fact overrides the older one.', weight: 'primary', directional: true },
  supersedes: { type: 'supersedes', label: 'supersedes', description: 'Bi-temporal replacement of a fact version.', weight: 'primary', directional: true },
  supports: { type: 'supports', label: 'supports', description: 'Evidence that carried the assumption.', weight: 'primary', directional: true },
  depends_on: { type: 'depends_on', label: 'depends on', description: 'The decision leans on this assumption.', weight: 'primary', directional: true },
  assumes: { type: 'assumes', label: 'assumes', description: 'The project rests on this assumption.', weight: 'primary', directional: true },
  applies_to: { type: 'applies_to', label: 'applies to', description: 'Assumption scope.', weight: 'structural', directional: true },
  affects: { type: 'affects', label: 'affects', description: 'Blast radius of a decision or fact.', weight: 'primary', directional: true },
  escalates: { type: 'escalates', label: 'escalates', description: 'Alert raised for a decision.', weight: 'primary', directional: true },
  raised_for: { type: 'raised_for', label: 'raised for', description: 'The fact an event introduced.', weight: 'primary', directional: true },
  observed_by: { type: 'observed_by', label: 'observed by', description: 'The source that witnessed the event.', weight: 'primary', directional: true },
  documented_in: { type: 'documented_in', label: 'documented in', description: 'Source carrying the evidence.', weight: 'structural', directional: true },
  author_of: { type: 'author_of', label: 'author of', description: 'Who wrote the source.', weight: 'structural', directional: true },
  contributes_to: { type: 'contributes_to', label: 'contributes to', description: 'Demonstrated contribution.', weight: 'structural', directional: true },
  works_on: { type: 'works_on', label: 'works on', description: 'Project involvement.', weight: 'structural', directional: true },
  owns: { type: 'owns', label: 'owns', description: 'Official ownership of a system.', weight: 'structural', directional: true },
  owns_decision: { type: 'owns_decision', label: 'owns decision', description: 'Accountable decision owner.', weight: 'structural', directional: true },
  member_of: { type: 'member_of', label: 'member of', description: 'Team membership.', weight: 'structural', directional: true },
  employs: { type: 'employs', label: 'employs', description: 'Team membership.', weight: 'structural', directional: true },
  part_of: { type: 'part_of', label: 'part of', description: 'Project belongs to a team.', weight: 'structural', directional: true },
  uses: { type: 'uses', label: 'uses', description: 'System or project dependency.', weight: 'structural', directional: true },
  about: { type: 'about', label: 'about', description: 'Source mentions this entity.', weight: 'structural' },
};

export function edgeLabel(type: EdgeType, fallback?: string): string {
  return EDGE_TYPE_META[type]?.label ?? fallback ?? String(type).replace(/_/g, ' ');
}

export function nodeTypeLabel(type: NodeType): string {
  return NODE_TYPE_META[type]?.label ?? type;
}

export function nodeStateLabel(state: NodeState): string {
  return NODE_STATE_META[state]?.label ?? state;
}

export function nodeStateTone(state: NodeState): Tone {
  return NODE_STATE_META[state]?.tone ?? 'neutral';
}

/* ------------------------------------------------------------ decisions & alerts */

export const DECISION_STATUS_META: Record<string, { label: string; tone: Tone; description: string }> = {
  active: { label: 'Active', tone: 'ok', description: 'Still stands on supported assumptions.' },
  needs_review: {
    label: 'Needs review',
    tone: 'warning',
    description: 'An assumption it depends on was challenged. A human must confirm.',
  },
  confirmed_stale: {
    label: 'Confirmed stale',
    tone: 'critical',
    description: 'A reviewer confirmed the basis no longer holds.',
  },
  superseded: { label: 'Superseded', tone: 'neutral', description: 'Replaced by a later decision.' },
  resolved: { label: 'Resolved', tone: 'ok', description: 'Reviewed and closed.' },
  potential: { label: 'Potentially affected', tone: 'warning', description: 'Below the review threshold; uncertain.' },
  investigate: { label: 'Worth investigating', tone: 'info', description: 'Weak signal — look before acting.' },
  none: { label: 'No review outstanding', tone: 'neutral', description: 'Nothing flagged.' },
};

export function decisionStatusMeta(status?: string | null) {
  return DECISION_STATUS_META[status ?? ''] ?? { label: status ?? 'Unknown', tone: 'neutral' as Tone, description: '' };
}

export const ALERT_STATUS_META: Record<AlertStatus, { label: string; tone: Tone; description: string }> = {
  NEW: { label: 'New', tone: 'info', description: 'Raised by the graph, not yet triaged.' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'warning', description: 'Assigned for human review.' },
  CONFIRMED_STALE: { label: 'Confirmed stale', tone: 'critical', description: 'A reviewer confirmed the basis is gone.' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral', description: 'Reviewed; no action needed.' },
  RESOLVED: { label: 'Resolved', tone: 'ok', description: 'Handled and closed.' },
};

export function alertStatusMeta(status?: string | null) {
  return ALERT_STATUS_META[status as AlertStatus] ?? { label: status ?? 'Unknown', tone: 'neutral' as Tone, description: '' };
}

export const SEVERITY_META: Record<Severity, { label: string; tone: Tone }> = {
  low: { label: 'Low severity', tone: 'neutral' },
  medium: { label: 'Medium severity', tone: 'warning' },
  high: { label: 'High severity', tone: 'critical' },
};

export const IMPACT_META: Record<Impact, { label: string; tone: Tone; rank: number }> = {
  high: { label: 'High impact', tone: 'critical', rank: 3 },
  medium: { label: 'Medium impact', tone: 'warning', rank: 2 },
  low: { label: 'Low impact', tone: 'neutral', rank: 1 },
};

/* ------------------------------------------------------------------- provenance */

export const PROVENANCE_KIND_META: Record<ProvenanceKind, { label: string; tone: Tone; order: number; description: string }> =
  {
    original_source: {
      label: 'Original source',
      tone: 'info',
      order: 1,
      description: 'Verbatim excerpt from the recorded message, ticket, PRD or meeting note.',
    },
    extracted_claim: {
      label: 'Extracted claim',
      tone: 'brand',
      order: 2,
      description: 'What deterministic extraction read out of that source. May need review.',
    },
    system_interpretation: {
      label: 'System interpretation',
      tone: 'warning',
      order: 3,
      description: "Tripwire's derived link or contradiction. This is a machine conclusion, not a human statement.",
    },
    business_decision: {
      label: 'Business decision',
      tone: 'ok',
      order: 4,
      description: 'A decision a human actually made and recorded.',
    },
  };

export const SOURCE_TYPE_META: Record<SourceType, { label: string; plural: string }> = {
  slack_message: { label: 'Slack message', plural: 'Slack messages' },
  ticket: { label: 'Ticket', plural: 'Tickets' },
  prd: { label: 'PRD', plural: 'PRDs' },
  meeting_note: { label: 'Meeting note', plural: 'Meeting notes' },
};

/** The backend's contribution vocabulary — richer than the view's `SourceType`. */
export const CONTRIBUTION_TYPE_LABELS: Record<string, string> = {
  resolved_ticket: 'Tickets resolved',
  authored_ticket: 'Tickets filed',
  commented_ticket: 'Ticket comments',
  authored_message: 'Messages posted',
  authored_meeting_note: 'Meeting notes written',
  contributed_to_meeting: 'Meetings contributed to',
  authored_document: 'Documents written',
  authored_prd: 'PRDs written',
  reviewed_document: 'Documents reviewed',
};

/**
 * Safe source-type lookup.
 *
 * The real backend reports artifact kinds ("Document", "Ticket", "Message") and
 * contribution types ("resolved_ticket") that are wider than this view vocabulary.
 * An unrecognised kind must render as itself — never crash the panel that is
 * displaying it (that is exactly how the People tab used to take the whole app down).
 */
export function sourceTypeMeta(type?: string | null): { label: string; plural: string } {
  const key = String(type ?? '').toLowerCase();
  const found = (SOURCE_TYPE_META as Record<string, { label: string; plural: string }>)[key];
  if (found) return found;
  const readable = key.replace(/[_-]+/g, ' ').trim();
  if (!readable) return { label: 'Source', plural: 'Sources' };
  const label = readable.charAt(0).toUpperCase() + readable.slice(1);
  return { label, plural: `${label}s` };
}

/** Safe contribution-label lookup, with the same never-crash guarantee. */
export function contributionTypeLabel(key?: string | null): string {
  const raw = String(key ?? '');
  const known = CONTRIBUTION_TYPE_LABELS[raw];
  if (known) return known;
  const readable = raw.replace(/[_-]+/g, ' ').trim();
  if (!readable) return 'Other evidence';
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

/** Safe provenance-kind lookup. */
export function provenanceKindMeta(kind?: string | null) {
  const key = String(kind ?? '') as ProvenanceKind;
  const found = (PROVENANCE_KIND_META as Record<string, (typeof PROVENANCE_KIND_META)[ProvenanceKind]>)[key];
  if (found) return found;
  return {
    kind: key,
    label: key ? key.replace(/[_-]+/g, ' ') : 'Step',
    tone: 'neutral' as Tone,
    order: 99,
    description: '',
  };
}

export const BELIEF_META: Record<string, { label: string; tone: Tone; description: string }> = {
  believed_true: { label: 'Believed true', tone: 'ok', description: 'Tripwire held this as true at that recorded time.' },
  believed_false: { label: 'Believed false', tone: 'critical', description: 'Tripwire held this as false at that recorded time.' },
  unknown_yet: {
    label: 'Not yet known',
    tone: 'neutral',
    description: 'Tripwire had not recorded this yet at that time.',
  },
  later_contradicted: {
    label: 'Later contradicted',
    tone: 'critical',
    description: 'Believed at that time; contradicted by something recorded later.',
  },
};

export function beliefMeta(belief?: string | null) {
  return BELIEF_META[belief ?? ''] ?? { label: belief ?? 'Unknown', tone: 'neutral' as Tone, description: '' };
}

/** Review transitions offered in the UI, mirroring contract §5. */
export const REVIEW_ACTIONS: Array<{ status: AlertStatus; label: string; tone: Tone; hint: string }> = [
  { status: 'NEEDS_REVIEW', label: 'Assign for review', tone: 'warning', hint: 'Send this to the responsible team.' },
  { status: 'CONFIRMED_STALE', label: 'Confirm stale', tone: 'critical', hint: 'The basis is genuinely gone.' },
  { status: 'DISMISSED', label: 'Dismiss', tone: 'neutral', hint: 'Reviewed; no action needed.' },
  { status: 'RESOLVED', label: 'Mark resolved', tone: 'ok', hint: 'Handled and closed.' },
];

export const TRIGGER_CHANNELS: Array<{ value: 'slack' | 'ticket' | 'prd' | 'meeting_note' | 'manual'; label: string }> = [
  { value: 'slack', label: 'Slack message' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'prd', label: 'PRD' },
  { value: 'meeting_note', label: 'Meeting note' },
  { value: 'manual', label: 'Manual entry' },
];
