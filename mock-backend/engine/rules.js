/**
 * Deterministic rule engine: event classification, contradiction propagation,
 * claim extraction and contribution-based expertise ranking.
 *
 * Everything here is transparent and reproducible: no model calls, no randomness.
 * The UI labels this output as `deterministic_rules` and never as a live AI service.
 */

export const METHOD = 'deterministic_rules';

/** Review thresholds (documented so the UI can explain them). */
export const THRESHOLDS = {
  requires_investigation: 0.55,
  uncertain_floor: 0.3,
};

/** Alternate evidence that partially offsets a contradiction, per assumption. */
export const ALTERNATE_EVIDENCE = {
  'ASM-DATA-RESIDENCY': [
    { fact_id: 'FACT-PARTNER-STATUS-REVIEW', effect: 'partially_supports', factor: 0.85,
      note: 'Renewal paperwork was submitted on 2026-08-30 and the review outcome is unpublished; the partner may be inside a grace period.' },
  ],
  'ASM-PARTNER-CERT-VALID': [
    { fact_id: 'FACT-DPA-SIGNED', effect: 'partially_supports', factor: 0.85,
      note: 'The signed DPA is still in force and contains certification obligations, but it does not by itself evidence a current certificate.' },
  ],
  'ASM-EU-DATA-TRANSFER': [
    { fact_id: 'FACT-IRELAND-WAREHOUSE-EU', effect: 'strongly_supports', factor: 0.5,
      note: 'The analytics warehouse is physically in Dublin and stays inside the EU.' },
  ],
  'ASM-COST-CEILING': [],
  'ASM-ATLANTA-DEMAND': [],
  'ASM-FX-VOLATILITY': [],
  'ASM-LATENCY-BUDGET': [],
  'ASM-SSO-MANDATE': [],
};

/** Event rules. First match wins; the matched rule decides what the engine does. */
export const EVENT_RULES = [
  {
    id: 'certification_lost',
    type: 'certification_lost',
    confidence: 0.92,
    summary: 'Frankfurt hosting partner lost its EU compliance certification',
    requires: [/certificat/i],
    negative: [/(lost|loses|losing|revoked|withdrawn|suspended|expired|expired?|lapsed|no longer|invalid|failed)/i],
    subject: [/(frankfurt|hosting partner|hosting provider|eu (data|compliance|certification)|residency)/i],
    contradicts: 'FACT-FRANKFURT-EU-CERTIFIED',
    new_fact: {
      id: 'FACT-FRANKFURT-EU-CERT-LOST',
      statement: 'Frankfurt Hosting GmbH no longer holds a current EU data-residency certification.',
      kind: 'observed_fact',
      confidence: 0.92,
      supports: [],
      system_ids: ['SYS-FRANKFURT-HOSTING'],
      project_ids: ['PRJ-EU-LAUNCH'],
    },
    uncertainty: [
      'The report does not state the exact lapse date, so validity is recorded from the report timestamp.',
      'The renewal review outcome is unpublished; a grace period cannot be excluded.',
    ],
  },
];

export function classifyEvent(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  for (const rule of EVENT_RULES) {
    const req = rule.requires.every((re) => re.test(raw));
    const neg = (rule.negative || []).some((re) => re.test(raw));
    const sub = (rule.subject || []).some((re) => re.test(raw));
    if (req && neg && sub) {
      return {
        rule,
        matched_terms: [...new Set((raw.match(/[A-Za-z][A-Za-z-]{3,}/g) || [])
          .filter((w) => /certificat|frankfurt|hosting|residency|complian|lost|lapse/i.test(w))
          .map((w) => w.toLowerCase()))],
      };
    }
  }
  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Propagate a contradiction through assumptions to dependent decisions.
 * Returns flagged decisions, uncertain decisions and demonstrably unaffected ones.
 */
export function propagate(event, dataset) {
  const rule = event.rule;
  const contradictedFactId = rule.contradicts;
  const newFactId = rule.new_fact.id;

  const assumptionNodes = dataset.nodes.filter((n) => n.type === 'assumption');
  const decisionNodes = dataset.nodes.filter((n) => n.type === 'decision');
  const nodeById = new Map(dataset.nodes.map((n) => [n.id, n]));

  const affectedAssumptions = assumptionNodes
    .filter((a) => (a.properties.supported_by || []).includes(contradictedFactId))
    .map((a) => {
      const alternates = ALTERNATE_EVIDENCE[a.id] || [];
      const factor = alternates.reduce((acc, alt) => Math.min(acc, alt.factor), 1);
      return {
        id: a.id,
        label: a.label,
        relation: 'supported_by',
        confidence: round2(rule.confidence * factor),
        status: 'challenged',
        alternate_evidence: alternates.map((alt) => ({
          ...alt,
          summary: nodeById.get(alt.fact_id)?.summary || '',
        })),
      };
    });

  const affectedIds = new Set(affectedAssumptions.map((a) => a.id));
  const flagged = [];
  const uncertain = [];
  const notAffected = [];

  for (const d of decisionNodes) {
    const deps = d.properties.assumption_ids || [];
    const touched = deps.filter((id) => affectedIds.has(id));
    if (touched.length === 0) {
      notAffected.push({
        id: d.id,
        label: d.label,
        reason: 'No path in the graph reaches a contradicted fact: none of its assumptions are supported by the changed fact.',
      });
      continue;
    }
    const alternates = touched.flatMap((id) => ALTERNATE_EVIDENCE[id] || []);
    const factor = alternates.reduce((acc, alt) => Math.min(acc, alt.factor), 1);

    // Relevance: does the change touch a system this decision actually covers?
    // A contradiction that only reaches the decision through a generic assumption is
    // secondary exposure, not direct exposure - so it is scored lower, not flagged blindly.
    const changedSystems = new Set((rule.new_fact.system_ids || []));
    const directSystems = new Set(d.properties.system_ids || []);
    for (const projectId of d.project_ids || []) {
      for (const e of dataset.edges.filter((x) => x.source === projectId && x.type === 'uses')) directSystems.add(e.target);
    }
    const directlyRelevant = [...changedSystems].some((s) => directSystems.has(s));
    const relevance = directlyRelevant ? 1 : 0.55;

    const impact = d.properties.impact_weight ?? 0.5;
    const confidence = round2(rule.confidence * (0.5 + 0.5 * impact) * factor * relevance);
    const relevanceNote = directlyRelevant
      ? `It directly covers ${[...changedSystems].join(', ')}.`
      : `It does not directly cover ${[...changedSystems].join(', ')} (it covers ${[...directSystems].join(', ') || 'no recorded system'}), so this is secondary exposure.`;
    const record = {
      id: d.id,
      label: d.label,
      status: confidence >= THRESHOLDS.requires_investigation ? 'needs_review' : 'potentially_affected',
      impact: impact >= 0.7 ? 'high' : impact >= 0.45 ? 'medium' : 'low',
      confidence,
      requires_investigation: confidence >= THRESHOLDS.requires_investigation,
      directly_relevant: directlyRelevant,
      relevance_factor: relevance,
      alternate_evidence: alternates.map((alt) => ({
        fact_id: alt.fact_id,
        summary: nodeById.get(alt.fact_id)?.summary || '',
        effect: alt.effect,
        note: alt.note,
      })),
      assumption_ids: touched,
      reason: `Depends on ${touched.map((t) => nodeById.get(t)?.label || t).join(', ')}, which is supported only by the contradicted fact ${contradictedFactId}. ${relevanceNote}`,
    };
    if (record.requires_investigation) flagged.push(record);
    else if (confidence >= THRESHOLDS.uncertain_floor) {
      uncertain.push({
        ...record,
        reason: `${record.reason} Confidence ${confidence} is below the review threshold of ${THRESHOLDS.requires_investigation}; alternate evidence must be checked by a human before any conclusion.`,
      });
    } else {
      notAffected.push({
        id: d.id,
        label: d.label,
        reason: `Path exists but confidence ${confidence} is too low to flag; the dependency is hedged by other assumptions.`,
      });
    }
  }

  // Give the unaffected neighbours an explained reason instead of a blanket dismissal.
  const affectedProjects = new Set(flagged.flatMap((f) => nodeById.get(f.id)?.project_ids || []));
  const affectedSystems = new Set(flagged.flatMap((f) => nodeById.get(f.id)?.properties?.system_ids || []));
  const explained = notAffected.map((n) => {
    const node = nodeById.get(n.id);
    if (!node) return n;
    const sharedProject = (node.project_ids || []).find((p) => affectedProjects.has(p));
    const sharedSystem = (node.properties.system_ids || []).find((s) => affectedSystems.has(s));
    if (sharedProject || sharedSystem) {
      return {
        ...n,
        reason: `Related through ${sharedProject || sharedSystem} to a flagged decision, but its own assumptions (${(node.properties.assumption_ids || []).join(', ') || 'none'}) are not supported by the changed fact.`,
      };
    }
    return n;
  });

  const projects = [...new Set([...affectedProjects])].map((p) => ({
    id: p,
    label: nodeById.get(p)?.label || p,
    impact: flagged.some((f) => (nodeById.get(f.id)?.project_ids || []).includes(p)) ? 'high' : 'low',
  }));
  const systems = [...new Set([...affectedSystems])].map((s) => ({
    id: s,
    label: nodeById.get(s)?.label || s,
    impact: s === rule.new_fact.system_ids?.[0] ? 'high' : 'medium',
  }));

  const decisions = flagged.sort((a, b) => b.confidence - a.confidence);

  return {
    assumptions: affectedAssumptions,
    decisions,
    projects,
    systems,
    not_affected: explained,
    uncertain,
    flagged_ids: decisions.map((d) => d.id),
    contradicted_fact_id: contradictedFactId,
    new_fact_id: newFactId,
  };
}

const TOPIC_TERMS = [
  { re: /frankfurt/i, ids: ['SYS-FRANKFURT-HOSTING'], weight: 0.8 },
  { re: /(checkout)/i, ids: ['SYS-EU-CHECKOUT'], weight: 0.8 },
  { re: /(residency|region pin|data\s*residenc)/i, ids: ['SYS-DATA-RESIDENCY-GATEWAY', 'ASM-DATA-RESIDENCY'], weight: 0.75 },
  { re: /\bcrm\b/i, ids: ['SYS-CRM-SYNC'], weight: 0.8 },
  { re: /(pricing|\bfx\b)/i, ids: ['SYS-PRICING-ENGINE'], weight: 0.7 },
  { re: /(\bidentity\b|\bsso\b)/i, ids: ['SYS-IDENTITY'], weight: 0.8 },
  { re: /(warehouse|analytics)/i, ids: ['SYS-ANALYTICS-WAREHOUSE'], weight: 0.7 },
  { re: /notification/i, ids: ['SYS-NOTIFICATIONS'], weight: 0.7 },
  { re: /(eu launch|launch plan|launch date)/i, ids: ['PRJ-EU-LAUNCH', 'DEC-EU-LAUNCH'], weight: 0.75 },
  { re: /certificat/i, ids: ['FACT-FRANKFURT-EU-CERTIFIED', 'ASM-PARTNER-CERT-VALID'], weight: 0.7 },
  { re: /(\bdpa\b|data processing agreement)/i, ids: ['DEC-DPA-TERMS'], weight: 0.8 },
  { re: /atlanta|us-east/i, ids: ['PRJ-ATLANTA-RETRY'], weight: 0.7 },
];

export function linkEntities(text) {
  const hits = new Map();
  for (const term of TOPIC_TERMS) {
    if (term.re.test(text)) {
      for (const id of term.ids) hits.set(id, Math.max(hits.get(id) || 0, term.weight));
    }
  }
  return [...hits.entries()].map(([id, confidence]) => ({ id, confidence }));
}

/** Rule-based claim extraction used by POST /api/ingest. */
export function extractClaims(text, { sourceType = 'slack_message' } = {}) {
  const sentences = (text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);

  const claims = [];
  let n = 0;
  for (const sentence of sentences) {
    const links = linkEntities(sentence);
    const best = links.reduce((acc, l) => Math.max(acc, l.confidence), 0);
    const looksFactual = /(is|are|was|were|has|have|will|must|should|confirmed|verified|completed|shipped|failed|lost|signed|approved)\b/i.test(sentence);
    if (!looksFactual && links.length === 0) continue;
    n += 1;
    const needsReview = best < 0.8 || links.length === 0;
    claims.push({
      id: `CLM-${String(n).padStart(3, '0')}`,
      kind: 'fact',
      text: sentence,
      confidence: round2(best || 0.35),
      needs_review: needsReview,
      reason: links.length === 0
        ? 'No known entity matched this statement, so it was stored without a graph link and needs human review.'
        : needsReview
          ? 'Linked with below-threshold confidence; a reviewer should confirm the link.'
          : 'Matched known entities with high confidence.',
      linked_entity_ids: links.map((l) => l.id),
      materialised_fact_id: null,
    });
  }

  const unmatched = [...new Set((text || '').match(/\b[A-Za-z][A-Za-z0-9-]{4,}\b/g) || [])]
    .filter((w) => !/^(should|would|could|their|there|these|those|which|while|about|after|before|because|between|please|thanks|update)$/i.test(w))
    .filter((w) => !/^(is|are|was|were|has|have|had|will|must|the|and|for|with|from|that|this|into|over|when|then|than|they|them|also|only|until|since|does|done|been|both|each|more|most|much|such|some|very|just|your|ours)$/i.test(w))
    .slice(0, 6);

  return {
    method: METHOD,
    source_type: sourceType,
    claims,
    linked_entity_ids: [...new Set(claims.flatMap((c) => c.linked_entity_ids))],
    unmatched_terms: unmatched,
  };
}

/** Contribution weights used by the expertise ranking (transparent, not learned). */
export const EXPERT_WEIGHTS = {
  tickets_resolved: 3,
  tickets_authored: 2,
  documents: 2.5,
  meeting_notes: 2,
  messages: 1,
  decisions_touched: 2.5,
};

export const EXPERT_LIMITATIONS =
  'Contribution counts only - this reflects demonstrated activity in the recorded sources, not a certified skill claim, and it can miss work that was never recorded.';

/**
 * Rank people by evidence of contribution to a system.
 * Deliberately not "who appears most often": only activity linked to the system counts,
 * and the ranking explanation names the signals that drove it.
 */
export function rankExperts(dataset, systemId, limit = 5) {
  const people = dataset.nodes.filter((n) => n.type === 'person');
  const decisions = dataset.nodes.filter((n) => n.type === 'decision');
  const relevantSources = dataset.sources.filter((s) => (s.entity_ids || []).includes(systemId));
  const sourceById = new Map(dataset.sources.map((s) => [s.id, s]));
  const scored = [];

  for (const person of people) {
    const authored = relevantSources.filter((s) => s.author_id === person.id);
    const counts = {
      tickets_authored: authored.filter((s) => s.type === 'ticket').length,
      tickets_resolved: authored.filter((s) => s.type === 'ticket' && s.metadata && s.metadata.resolved_by === person.id).length,
      documents: authored.filter((s) => s.type === 'prd').length,
      meeting_notes: authored.filter((s) => s.type === 'meeting_note').length,
      messages: authored.filter((s) => s.type === 'slack_message').length,
      decisions_touched: decisions.filter((d) => d.properties.owner_id === person.id && (d.properties.system_ids || []).includes(systemId)).length,
    };
    const raw = Object.entries(counts).reduce((acc, [k, v]) => acc + v * (EXPERT_WEIGHTS[k] || 0), 0);
    if (raw <= 0) continue;
    const evidence = authored
      .map((s) => ({
        source_id: s.id,
        type: s.type,
        title: s.title,
        at: s.timestamp,
        why: s.type === 'ticket'
          ? (s.metadata && s.metadata.resolved_by === person.id
            ? `Resolved ticket touching this system: ${s.title}`
            : `Authored ticket touching this system: ${s.title}`)
          : s.type === 'prd'
            ? `Authored a PRD covering this system: ${s.title}`
            : s.type === 'meeting_note'
              ? `Recorded meeting decisions covering this system: ${s.title}`
              : `Posted about this system in ${s.title}`,
      }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 6);
    scored.push({ person, counts, raw, evidence });
  }

  scored.sort((a, b) => b.raw - a.raw || (a.person.id < b.person.id ? -1 : 1));
  const top = scored.slice(0, limit);
  const max = top[0]?.raw || 1;
  const systemLabel = dataset.nodes.find((n) => n.id === systemId)?.label || systemId;

  const experts = top.map((entry, i) => {
    const isOwner = (entry.person.properties.official_owner_of || []).includes(systemId);
    const signals = [];
    if (entry.counts.tickets_resolved) signals.push(`resolved tickets (${entry.counts.tickets_resolved})`);
    if (entry.counts.messages) signals.push(`messages (${entry.counts.messages})`);
    if (entry.counts.documents) signals.push(`authored PRDs (${entry.counts.documents})`);
    if (entry.counts.tickets_authored) signals.push(`authored tickets (${entry.counts.tickets_authored})`);
    if (entry.counts.meeting_notes) signals.push(`meeting notes (${entry.counts.meeting_notes})`);
    if (entry.counts.decisions_touched) signals.push(`decisions they own (${entry.counts.decisions_touched})`);
    const uncertainty = [];
    if (!isOwner) uncertainty.push('Not the listed owner of this system.');
    else uncertainty.push('Listed owner, but with less recorded hands-on activity than the top-ranked person.');
    if (!entry.counts.documents && !entry.counts.meeting_notes) {
      uncertainty.push('No design document or meeting note authored for this system; evidence skews to operational work.');
    }
    uncertainty.push(`Recording bias: ${systemLabel} work discussed in unlogged calls is invisible here.`);
    return {
      person_id: entry.person.id,
      name: entry.person.label,
      team_id: entry.person.properties.team_id,
      team_name: dataset.nodes.find((n) => n.id === entry.person.properties.team_id)?.label || null,
      title: entry.person.properties.title,
      score: round2(entry.raw / max),
      rank: i + 1,
      is_official_owner: isOwner,
      contribution_counts: entry.counts,
      total_contributions: Object.values(entry.counts).reduce((a, b) => a + b, 0),
      evidence: entry.evidence,
      ranking_explanation: `Ranked #${i + 1} on ${signals.join(', ')} linked to ${systemLabel} - weighted by type of contribution, not by raw activity volume.`,
      uncertainty,
      limitations: EXPERT_LIMITATIONS,
    };
  });

  const excluded = people
    .filter((p) => !scored.some((s) => s.person.id === p.id))
    .map((p) => ({ person_id: p.id, name: p.label, reason: `No recorded contribution linked to ${systemId}, despite ${(p.properties.source_count || 0)} records authored elsewhere in the corpus.` }))
    .filter((p) => (dataset.nodes.find((n) => n.id === p.person_id)?.properties.source_count || 0) >= 5);

  return {
    system_id: systemId,
    system_label: systemLabel,
    experts,
    method: `contribution_weight_v${Object.keys(EXPERT_WEIGHTS).length}`,
    weights: EXPERT_WEIGHTS,
    excluded,
  };
}
