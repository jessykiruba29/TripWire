/**
 * Focused tests for the evidence components.
 *
 * Fixtures are literal objects typed as the API contract — never imported from
 * mock-backend, so a drifting backend cannot make these tests pass by accident.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProvenanceStep, SourceRecord } from '../../api/types';
import { ProvenanceChain } from './ProvenanceChain';
import { SourceCard, SourceList } from './SourceEvidence';

const LIVE_SOURCE: SourceRecord = {
  id: 'SRC-1',
  type: 'slack_message',
  title: '#payments-platform',
  external_id: 'C0129/thread-44',
  author_id: 'PERSON-1',
  author_name: 'Ana Alvarez',
  timestamp: '2026-04-02T09:15:00.000Z',
  recorded_at: '2026-04-02T09:15:00.000Z',
  text: 'Refunds are failing after the PSP migration.',
  excerpt: 'Refunds are failing after the PSP migration.',
  simulated: false,
};

const SIMULATED_SOURCE: SourceRecord = {
  id: 'SRC-2',
  type: 'meeting_note',
  title: 'Platform sync',
  author_name: 'Ben Osei',
  timestamp: '2026-04-01T14:00:00.000Z',
  recorded_at: '2026-04-06T08:30:00.000Z',
  text: 'Line one.\nLine two.',
  simulated: true,
};

const CHAIN: ProvenanceStep[] = [
  {
    kind: 'business_decision',
    ref_id: 'DEC-1',
    label: 'Rolled back the PSP migration',
    actor: 'Ben Osei',
    at: '2026-04-07T10:00:00.000Z',
  },
  {
    kind: 'original_source',
    ref_id: 'SRC-1',
    label: 'Slack message in #payments-platform',
    actor: 'Ana Alvarez',
    at: '2026-04-02T09:15:00.000Z',
    text: 'Refunds are failing.',
    simulated: true,
  },
  {
    kind: 'system_interpretation',
    ref_id: 'FACT-2',
    label: 'Contradicts the assumption that refunds are healthy',
    method: 'deterministic_conflict_detection',
    confidence: 0.81,
    note: 'Derived from FACT-1.',
  },
  {
    kind: 'extracted_claim',
    ref_id: 'FACT-1',
    label: 'Refund success rate dropped',
    at: '2026-04-02T09:16:00.000Z',
    confidence: 0.64,
  },
];

describe('SourceList', () => {
  it('renders an honest empty state and invents no rows', () => {
    render(
      <SourceList
        sources={[]}
        emptyTitle="No evidence yet"
        emptyText="No source records were returned for this selection."
      />,
    );

    expect(screen.getByText('No evidence yet')).toBeInTheDocument();
    expect(screen.getByText('No source records were returned for this selection.')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders selectable rows as real buttons with aria-pressed', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <SourceList
        sources={[LIVE_SOURCE, SIMULATED_SOURCE]}
        selectedSourceId="SRC-2"
        onSelect={onSelect}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'true');

    await user.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(LIVE_SOURCE);
  });

  it('renders plain, non-interactive rows when no handler is given', () => {
    render(<SourceList sources={[LIVE_SOURCE]} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('#payments-platform')).toBeInTheDocument();
  });

  it('labels simulated and live records explicitly', () => {
    render(<SourceList sources={[LIVE_SOURCE, SIMULATED_SOURCE]} />);

    expect(screen.getByText('Live record')).toBeInTheDocument();
    expect(screen.getByText('Simulated source')).toBeInTheDocument();
  });

  it('keeps the absolute time available alongside the relative one', () => {
    render(<SourceList sources={[LIVE_SOURCE]} />);

    const relative = screen.getByText(/ago|in /);
    expect(relative).toHaveAttribute('title');
    expect(relative.getAttribute('title')).toContain('2026');
  });
});

describe('SourceCard', () => {
  it('renders the verbatim text with newlines preserved', () => {
    const { container } = render(<SourceCard source={SIMULATED_SOURCE} />);

    const quote = container.querySelector('blockquote.ev-verbatim');
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toBe('Line one.\nLine two.');
  });

  it('separates "true in the world" from "known to Tripwire" when they differ', () => {
    render(<SourceCard source={SIMULATED_SOURCE} />);

    expect(screen.getByText('True in the world')).toBeInTheDocument();
    expect(screen.getByText('Known to Tripwire')).toBeInTheDocument();
    expect(screen.getByText(/Tripwire only learned about it/)).toBeInTheDocument();
  });

  it('never invents values for fields the backend omitted', () => {
    const sparse: SourceRecord = {
      id: 'SRC-9',
      type: 'prd',
      title: 'Payments PRD',
      timestamp: '2026-01-05T00:00:00.000Z',
      text: 'Draft only.',
      simulated: false,
    };

    render(<SourceCard source={sparse} />);

    expect(screen.getAllByText('Not available from the backend').length).toBeGreaterThan(0);
  });

  it('renders linked entities as buttons that report their id', async () => {
    const onSelectEntity = vi.fn();
    const user = userEvent.setup();
    render(
      <SourceCard
        source={LIVE_SOURCE}
        detail={{
          supports_facts: [{ id: 'FACT-1', label: 'Refund success rate dropped' }],
          linked_entities: [{ id: 'SYS-4', type: 'system', label: 'Payments API' }],
        }}
        onSelectEntity={onSelectEntity}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Refund success rate dropped/ }));
    expect(onSelectEntity).toHaveBeenCalledWith('FACT-1');
  });

  it('offers a close control only when a handler is provided', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SourceCard source={LIVE_SOURCE} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close source detail' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ProvenanceChain', () => {
  it('orders the four levels from original source to business decision', () => {
    render(<ProvenanceChain chain={CHAIN} factId="FACT-1" />);

    const steps = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('Original source');
    expect(steps[1]).toContain('Extracted claim');
    expect(steps[2]).toContain('System interpretation');
    expect(steps[3]).toContain('Business decision');
  });

  it('marks the system interpretation as machine-derived, not a human statement', () => {
    render(<ProvenanceChain chain={CHAIN} />);

    const steps = screen.getAllByRole('listitem');
    expect(steps[2]).toHaveTextContent('Machine-derived conclusion');
    expect(steps[2]).toHaveTextContent('This is a machine conclusion, not a human statement.');
    expect(steps[0]).not.toHaveTextContent('Machine-derived conclusion');
    expect(steps[3]).not.toHaveTextContent('Machine-derived conclusion');
  });

  it('shows confidence metres only where the backend supplied a number', () => {
    render(<ProvenanceChain chain={CHAIN} />);

    const meters = screen.getAllByRole('meter');
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
      'Extracted claim confidence',
      'System interpretation confidence',
    ]);
  });

  it('flags a simulated step and keeps its method visible', () => {
    render(<ProvenanceChain chain={CHAIN} />);

    expect(screen.getByText('Simulated source')).toBeInTheDocument();
    expect(screen.getByText('deterministic_conflict_detection')).toBeInTheDocument();
  });

  it('renders loading, error and empty states', () => {
    const { rerender } = render(<ProvenanceChain chain={[]} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading provenance chain');

    rerender(<ProvenanceChain chain={[]} error={{ message: 'provenance unavailable', code: 'E_PROV', status: 502 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('provenance unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502');

    rerender(<ProvenanceChain chain={[]} />);
    expect(screen.getByText('No provenance chain')).toBeInTheDocument();
  });
});
