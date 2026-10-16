/**
 * Focused tests for the contributor ranking panel.
 *
 * The fixtures are literal objects typed as the API contract. The tests pin the
 * honesty requirements: ownership is stated either way, and the ranking basis
 * (explanation, limitations, uncertainty, exclusions) is always on screen.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Expert, ExpertsResponse } from '../../api/types';
import { ExpertPanel } from './ExpertPanel';

const OWNER: Expert = {
  person_id: 'PERSON-001',
  name: 'Ana Alvarez',
  team_id: 'TEAM-9',
  team_name: 'Payments Platform',
  title: 'Staff Engineer',
  score: 0.72,
  rank: 1,
  is_official_owner: true,
  contribution_counts: { tickets_resolved: 14, messages: 61 },
  total_contributions: 75,
  evidence: [
    {
      source_id: 'SRC-1',
      type: 'ticket',
      title: 'Refund webhook retries',
      at: '2026-03-04T10:00:00.000Z',
      why: 'Authored the incident ticket and the follow-up fix.',
    },
  ],
  ranking_explanation:
    'Ranked first because they authored and resolved the most payment-adjacent tickets.',
  uncertainty: ['Some Slack threads were not attributable to a single author.'],
  limitations: 'Ticket authorship can overstate involvement on shared workstreams.',
};

const NON_OWNER: Expert = {
  person_id: 'PERSON-002',
  name: 'Ben Osei',
  team_id: null,
  title: 'Site Reliability Engineer',
  score: 0.31,
  rank: 2,
  is_official_owner: false,
  contribution_counts: { documents: 3 },
  total_contributions: 3,
  evidence: [],
  ranking_explanation: 'Ranked second on the strength of one design document.',
  uncertainty: [],
  limitations: 'A single document is a weak evidence basis.',
};

const RESPONSE: ExpertsResponse = {
  system_id: 'SYS-1',
  system_label: 'Payments API',
  experts: [OWNER, NON_OWNER],
  method: 'Deterministic weighted contribution count over source records.',
  excluded: [
    {
      person_id: 'PERSON-099',
      name: 'Kit Novak',
      reason: 'Only mentioned in the alert narrative; no recorded contribution.',
    },
  ],
  recommended_contact: {
    person_id: 'PERSON-007',
    name: 'Dara Quinn',
    why: 'Owns the payment retry service.',
  },
};

describe('ExpertPanel', () => {
  it('shows the system label, the method footnote and the ranked people', () => {
    render(<ExpertPanel response={RESPONSE} />);

    expect(screen.getByRole('heading', { name: /Payments API/ })).toBeInTheDocument();
    expect(screen.getByText(/Deterministic weighted contribution count/)).toBeInTheDocument();
    expect(screen.getByText('Ana Alvarez')).toBeInTheDocument();
    expect(screen.getByText('Ben Osei')).toBeInTheDocument();
  });

  it('states ownership explicitly, including when someone is not the listed owner', () => {
    render(<ExpertPanel response={RESPONSE} />);

    expect(screen.getByText('Listed owner')).toBeInTheDocument();
    expect(screen.getByText('Not the listed owner')).toBeInTheDocument();
  });

  it('labels the score as a contribution score and humanises the counts', () => {
    render(<ExpertPanel response={RESPONSE} />);

    expect(screen.getByRole('meter', { name: 'Contribution score for Ana Alvarez' })).toBeInTheDocument();
    expect(screen.getByText('Resolved tickets')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('75 recorded contributions')).toBeInTheDocument();
  });

  it('always renders the ranking explanation, limitations and every uncertainty string', () => {
    render(<ExpertPanel response={RESPONSE} />);

    expect(screen.getByText(/Ranked first because they authored and resolved/)).toBeInTheDocument();
    expect(screen.getAllByText('Limitations')).toHaveLength(2);
    expect(screen.getByText(/Ticket authorship can overstate involvement/)).toBeInTheDocument();
    expect(screen.getByText(/Some Slack threads were not attributable/)).toBeInTheDocument();
    expect(screen.getByText(/listed no specific uncertainties/)).toBeInTheDocument();
  });

  it('makes the evidence basis explicit rather than relying on frequency', () => {
    render(<ExpertPanel response={RESPONSE} />);

    expect(screen.getAllByText('Evidence of contribution')).toHaveLength(2);
    expect(screen.getByText('Refund webhook retries')).toBeInTheDocument();
    expect(screen.getByText(/Authored the incident ticket/)).toBeInTheDocument();
  });

  it('lists who was excluded from the ranking and why, behind a disclosure', async () => {
    const user = userEvent.setup();
    render(<ExpertPanel response={RESPONSE} />);

    const toggle = screen.getByRole('button', { name: /Excluded from ranking/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Kit Novak')).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Kit Novak')).toBeInTheDocument();
    expect(screen.getByText(/Only mentioned in the alert narrative/)).toBeInTheDocument();
  });

  it('gives the recommended contact its own labelled block', () => {
    render(<ExpertPanel response={RESPONSE} />);

    expect(screen.getByText('Recommended contact')).toBeInTheDocument();
    expect(screen.getByText('Dara Quinn')).toBeInTheDocument();
    expect(screen.getByText(/Owns the payment retry service/)).toBeInTheDocument();
  });

  it('reports the person id when a ranked name is activated', async () => {
    const onSelectPerson = vi.fn();
    const user = userEvent.setup();
    render(<ExpertPanel response={RESPONSE} onSelectPerson={onSelectPerson} />);

    await user.click(screen.getByRole('button', { name: 'Ana Alvarez' }));
    expect(onSelectPerson).toHaveBeenCalledWith('PERSON-001');
  });

  it('renders loading, error and empty states', () => {
    const { rerender } = render(<ExpertPanel response={null} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Ranking contributors');

    rerender(<ExpertPanel response={null} error={{ message: 'ranking failed', status: 500 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('ranking failed');

    rerender(<ExpertPanel response={null} />);
    expect(screen.getByText('No ranking requested')).toBeInTheDocument();
  });
});
