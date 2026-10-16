import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { HistoryResponse, TimelineEntry } from '../../api/types';
import { HistoryPanel } from './HistoryPanel';
import { TimelineFeed } from './TimelineFeed';

const noop = () => {};

const history: HistoryResponse = {
  as_of: '2026-03-05T00:00:00.000Z',
  mode: 'mock-backend',
  demo_clock: '2026-03-05T09:00:00.000Z',
  event_recorded_at: '2026-03-10T09:00:00.000Z',
  facts: [
    {
      id: 'FACT-FRANKFURT-EU-CERTIFIED',
      label: 'Frankfurt partner certified',
      statement: 'The Frankfurt hosting partner holds EU certification.',
      valid_from: '2025-01-01T00:00:00.000Z',
      valid_to: '2026-03-10T00:00:00.000Z',
      recorded_at: '2025-01-02T00:00:00.000Z',
      superseded_at: '2026-03-10T09:00:00.000Z',
      belief: 'later_contradicted',
      current_state: 'contradicted',
      confidence: 0.9,
    },
    {
      id: 'FACT-FRANKFURT-EU-LOST',
      label: 'Frankfurt partner lost certification',
      valid_from: '2026-03-10T00:00:00.000Z',
      valid_to: null,
      recorded_at: '2026-03-10T09:00:00.000Z',
      superseded_at: null,
      belief: 'believed_true',
      confidence: 0.95,
    },
  ],
  changes: [
    {
      at: '2026-03-10T09:00:00.000Z',
      kind: 'fact_contradicted',
      entity_id: 'FACT-FRANKFURT-EU-CERTIFIED',
      summary: 'A newer fact contradicted the certification claim.',
      actor: 'tripwire',
    },
  ],
  timeline: [],
  decisions: [
    {
      id: 'DEC-EU-LAUNCH',
      title: 'Launch EU region',
      status_at_time: 'active',
      status_now: 'needs_review',
      created_at: '2025-06-01T00:00:00.000Z',
    },
  ],
  notes: ['Reconstructed from recorded times, not re-stamped.'],
};

const entries: TimelineEntry[] = [
  {
    at: '2026-03-11T10:00:00.000Z',
    kind: 'alert_created',
    summary: 'Alert raised for the EU launch decision.',
    entity_ids: ['DEC-EU-LAUNCH'],
    actor: 'tripwire',
    source_type: 'slack_message',
  },
  {
    at: '2026-03-10T09:00:00.000Z',
    kind: 'fact_contradicted',
    summary: 'The certification claim was contradicted.',
    entity_ids: ['FACT-FRANKFURT-EU-CERTIFIED'],
    actor: 'tripwire',
  },
  {
    at: '2026-03-10T08:00:00.000Z',
    kind: 'event_recorded',
    summary: 'The partner certification was lost.',
    entity_ids: [],
    actor: 'ops-bot',
    source_type: 'ticket',
  },
];

describe('HistoryPanel', () => {
  it('shows a loading state while the history is being fetched', () => {
    render(<HistoryPanel history={null} asOf="2026-03-05" onAsOfChange={noop} loading />);
    expect(screen.getByText('Loading history…')).toBeInTheDocument();
  });

  it('shows an empty state when no history is loaded', () => {
    render(<HistoryPanel history={null} asOf="2026-03-05" onAsOfChange={noop} />);
    expect(screen.getByText('No history loaded')).toBeInTheDocument();
  });

  it('shows an error state with the backend message', () => {
    render(
      <HistoryPanel
        history={null}
        asOf="2026-03-05"
        onAsOfChange={noop}
        error={{ message: 'History query failed', code: 'HISTORY_UNAVAILABLE', status: 503 }}
      />,
    );
    expect(screen.getByText('Could not load history')).toBeInTheDocument();
    expect(screen.getByText('History query failed')).toBeInTheDocument();
  });

  it('renders the recorded-time callout with mode and as_of verbatim', () => {
    render(<HistoryPanel history={history} asOf="2026-03-05" onAsOfChange={noop} />);
    expect(screen.getByText('This is a recorded-time view')).toBeInTheDocument();
    expect(screen.getByText('mock-backend')).toBeInTheDocument();
    expect(screen.getByText('2026-03-05T00:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('Reconstructed from recorded times, not re-stamped.')).toBeInTheDocument();
  });

  it('renders both time axes distinctly for every fact', () => {
    render(<HistoryPanel history={history} asOf="2026-03-05" onAsOfChange={noop} />);
    expect(screen.getAllByText(/True in the world \(valid time\)/)).toHaveLength(2);
    expect(screen.getAllByText(/Known to Tripwire \(recorded time\)/)).toHaveLength(2);
  });

  it('renders belief as a labelled badge', () => {
    render(<HistoryPanel history={history} asOf="2026-03-05" onAsOfChange={noop} />);
    expect(screen.getByText('Later contradicted')).toBeInTheDocument();
    expect(screen.getByText('Believed true')).toBeInTheDocument();
  });

  it('shows a decision status-at-time next to status-now', () => {
    render(<HistoryPanel history={history} asOf="2026-03-05" onAsOfChange={noop} />);
    expect(screen.getByText('Then')).toBeInTheDocument();
    expect(screen.getByText('Now')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
  });

  it('makes change entity ids clickable and reports the selection', () => {
    const onSelectEntity = vi.fn();
    render(
      <HistoryPanel history={history} asOf="2026-03-05" onAsOfChange={noop} onSelectEntity={onSelectEntity} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'FACT-FRANKFURT-EU-CERTIFIED' }));
    expect(onSelectEntity).toHaveBeenCalledWith('FACT-FRANKFURT-EU-CERTIFIED');
  });

  it('reports date changes from the date control', () => {
    const onAsOfChange = vi.fn();
    render(
      <HistoryPanel
        history={history}
        asOf="2026-03-05"
        onAsOfChange={onAsOfChange}
        minDate="2026-01-01"
        maxDate="2026-03-31"
      />,
    );
    fireEvent.change(screen.getByLabelText('Show what Tripwire believed on'), {
      target: { value: '2026-02-01' },
    });
    expect(onAsOfChange).toHaveBeenCalledWith('2026-02-01');
  });

  it('derives quick-set dates from the bounds and event time (no hardcoded dates)', () => {
    const onAsOfChange = vi.fn();
    render(
      <HistoryPanel
        history={history}
        asOf="2026-03-05"
        onAsOfChange={onAsOfChange}
        minDate="2026-01-01"
        maxDate="2026-03-31"
      />,
    );
    const beforeEvent = screen.getByRole('button', { name: 'Before the event' });
    expect(beforeEvent).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(beforeEvent);
    expect(onAsOfChange).toHaveBeenCalledWith('2026-03-09');
  });

  it('marks the active quick-set with aria-pressed', () => {
    render(
      <HistoryPanel
        history={history}
        asOf="2026-03-09"
        onAsOfChange={noop}
        minDate="2026-01-01"
        maxDate="2026-03-31"
      />,
    );
    expect(screen.getByRole('button', { name: 'Before the event' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onResetToNow from the "Back to now" button', () => {
    const onResetToNow = vi.fn();
    render(<HistoryPanel history={history} asOf="2026-03-05" onAsOfChange={noop} onResetToNow={onResetToNow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }));
    expect(onResetToNow).toHaveBeenCalledTimes(1);
  });
});

describe('TimelineFeed', () => {
  it('groups entries under a day heading', () => {
    const { container } = render(<TimelineFeed entries={entries} />);
    expect(container.querySelectorAll('.hist-timeline__day-heading')).toHaveLength(2);
    expect(screen.getByText('Alert raised for the EU launch decision.')).toBeInTheDocument();
    expect(screen.getByText('The partner certification was lost.')).toBeInTheDocument();
  });

  it('truncates to the limit and says so honestly', () => {
    render(<TimelineFeed entries={entries} limit={2} />);
    expect(screen.getByText(/Showing the most recent 2 of 3 entries/)).toBeInTheDocument();
    expect(screen.queryByText('The partner certification was lost.')).not.toBeInTheDocument();
  });

  it('does not claim truncation when nothing is hidden', () => {
    render(<TimelineFeed entries={entries} />);
    expect(screen.queryByText(/Showing the most recent/)).not.toBeInTheDocument();
  });

  it('makes entity ids clickable and reports the selection', () => {
    const onSelectEntity = vi.fn();
    render(<TimelineFeed entries={entries} onSelectEntity={onSelectEntity} />);
    fireEvent.click(screen.getByRole('button', { name: 'DEC-EU-LAUNCH' }));
    expect(onSelectEntity).toHaveBeenCalledWith('DEC-EU-LAUNCH');
  });

  it('uses the honest empty title when there is nothing to show', () => {
    render(<TimelineFeed entries={[]} emptyTitle="Nothing recorded yet" />);
    expect(screen.getByText('Nothing recorded yet')).toBeInTheDocument();
  });

  it('shows an error state when the timeline cannot be loaded', () => {
    render(<TimelineFeed entries={[]} error={{ message: 'Timeline unavailable', status: 500 }} />);
    expect(screen.getByText('Could not load the timeline')).toBeInTheDocument();
    expect(screen.getByText('Timeline unavailable')).toBeInTheDocument();
  });

  it('announces a refresh while keeping the loaded entries visible', () => {
    render(<TimelineFeed entries={entries} loading />);
    expect(screen.getByText('Refreshing timeline…')).toBeInTheDocument();
    expect(screen.getByText('Alert raised for the EU launch decision.')).toBeInTheDocument();
  });
});
