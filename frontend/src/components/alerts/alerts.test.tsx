import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Alert, AlertsResponse } from '../../api/types';
import { AlertReviewPanel } from './AlertReviewPanel';

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'ALERT-1',
    status: 'NEW',
    severity: 'high',
    title: 'EU launch basis may no longer hold',
    what_changed: 'The Frankfurt partner lost its EU certification.',
    contradicted_fact_id: 'FACT-FRANKFURT-EU-CERTIFIED',
    new_fact_id: 'FACT-FRANKFURT-EU-LOST',
    assumption_ids: ['ASM-DATA-RESIDENCY'],
    decision_ids: ['DEC-EU-LAUNCH'],
    project_ids: ['PROJ-EU-REGION'],
    confidence: 0.82,
    requires_investigation: true,
    why: 'The decision depends on an assumption supported by the contradicted fact.',
    source_ids: ['SRC-1'],
    people: [{ id: 'P-1', name: 'Dana Ito', role: 'Residency owner', reason: 'Owns the affected assumption.' }],
    history: [
      { at: '2026-03-10T09:05:00.000Z', from: null, to: 'NEW', actor: 'tripwire', note: 'Raised automatically.' },
    ],
    created_at: '2026-03-10T09:05:00.000Z',
    updated_at: '2026-03-10T09:05:00.000Z',
    ...overrides,
  };
}

function makeResponse(overrides: Partial<AlertsResponse> = {}): AlertsResponse {
  return { alerts: [makeAlert()], total: 1, by_status: { NEW: 1 }, ...overrides };
}

describe('AlertReviewPanel', () => {
  it('shows a loading placeholder while alerts are being fetched', () => {
    const { container } = render(<AlertReviewPanel response={null} loading onReview={vi.fn()} />);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('shows the backend empty_reason instead of a generic empty state', () => {
    render(
      <AlertReviewPanel
        response={{ alerts: [], total: 0, by_status: {}, empty_reason: 'No open alerts for this decision.' }}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByText('No open alerts for this decision.')).toBeInTheDocument();
    expect(screen.queryByText('No alerts to review')).not.toBeInTheDocument();
  });

  it('falls back to a plain empty state when there is no empty_reason', () => {
    render(<AlertReviewPanel response={{ alerts: [], total: 0, by_status: {} }} onReview={vi.fn()} />);
    expect(screen.getByText('No alerts to review')).toBeInTheDocument();
  });

  it('shows an error state with the backend message', () => {
    render(
      <AlertReviewPanel
        response={null}
        onReview={vi.fn()}
        error={{ message: 'Alerts unavailable', code: 'ALERTS_DOWN', status: 500 }}
      />,
    );
    expect(screen.getByText('Could not load alerts')).toBeInTheDocument();
    expect(screen.getByText('Alerts unavailable')).toBeInTheDocument();
  });

  it('offers only the transitions the backend allows', () => {
    render(
      <AlertReviewPanel
        response={makeResponse({ allowed_transitions: { NEW: ['NEEDS_REVIEW', 'DISMISSED'] } })}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Assign for review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm stale' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark resolved' })).toBeNull();
  });

  it('falls back to REVIEW_ACTIONS when the backend advertises no transitions', () => {
    render(<AlertReviewPanel response={makeResponse()} onReview={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Assign for review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm stale' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
  });

  it('passes the review note and target status to onReview', () => {
    const onReview = vi.fn();
    render(<AlertReviewPanel response={makeResponse()} onReview={onReview} />);
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'Confirmed with the partner.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stale' }));
    expect(onReview).toHaveBeenCalledWith('ALERT-1', 'CONFIRMED_STALE', 'Confirmed with the partner.');
  });

  it('disables an alert\u2019s controls while it is busy', () => {
    const onReview = vi.fn();
    const { rerender } = render(<AlertReviewPanel response={makeResponse()} onReview={onReview} busyAlertId={null} />);
    expect(screen.getByRole('button', { name: 'Confirm stale' })).not.toBeDisabled();

    rerender(<AlertReviewPanel response={makeResponse()} onReview={onReview} busyAlertId="ALERT-1" />);
    expect(screen.getByRole('button', { name: 'Confirm stale' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    expect(screen.getByLabelText('Review note')).toBeDisabled();
    expect(screen.getByText('Submitting review…')).toBeInTheDocument();
  });

  it('surfaces a review error inline on the affected alert', () => {
    const onReview = vi.fn();
    const { rerender } = render(<AlertReviewPanel response={makeResponse()} onReview={onReview} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stale' }));

    rerender(
      <AlertReviewPanel
        response={makeResponse()}
        onReview={onReview}
        reviewError={{ message: 'Transition rejected by the backend.', code: 'INVALID_TRANSITION', status: 409 }}
      />,
    );
    expect(screen.getByText('Review failed')).toBeInTheDocument();
    expect(screen.getByText('Transition rejected by the backend.')).toBeInTheDocument();
  });

  it('renders the alert detail, audit trail and people', () => {
    const onSelectDecision = vi.fn();
    render(<AlertReviewPanel response={makeResponse()} onReview={vi.fn()} onSelectDecision={onSelectDecision} />);

    expect(screen.getByText('High severity')).toBeInTheDocument();
    expect(screen.getByText('New', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText('New', { selector: '.alerts-audit__item span.strong' })).toBeInTheDocument();
    expect(screen.getByText('Requires investigation')).toBeInTheDocument();
    expect(screen.getByText('FACT-FRANKFURT-EU-CERTIFIED')).toBeInTheDocument();
    expect(screen.getByText('FACT-FRANKFURT-EU-LOST')).toBeInTheDocument();
    expect(screen.getByText('Raised automatically.')).toBeInTheDocument();
    expect(screen.getByText('Dana Ito')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'DEC-EU-LAUNCH' }));
    expect(onSelectDecision).toHaveBeenCalledWith('DEC-EU-LAUNCH');
  });
});
