/**
 * Integration tests for the whole application, running against the real
 * in-browser reference engine (mock mode) — the same code path the backend serves.
 *
 * jsdom has no 2D canvas, which is exactly why the graph has a text view: these
 * tests exercise that real fallback rather than mocking the graph out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

beforeEach(() => {
  vi.stubEnv('VITE_API_MODE', 'mock');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderApp() {
  const user = userEvent.setup();
  const view = render(<App />);
  // "MOCK MODE" in upper case is the banner label; the header badge reads "Mock mode".
  await screen.findByText('MOCK MODE', {}, { timeout: 15000 });
  return { user, view };
}

async function runScenario(user: ReturnType<typeof userEvent.setup>) {
  const scenario = screen.getByTestId('scenario-panel');
  const button = within(scenario).getByRole('button', { name: /Run Frankfurt scenario/i });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await within(scenario).findByText('Event applied', {}, { timeout: 15000 });
  return scenario;
}

describe('Tripwire application', () => {
  it('boots into mock mode and says so, rather than passing fixtures off as live data', async () => {
    await renderApp();

    expect(screen.getByText('MOCK MODE')).toBeInTheDocument();
    expect(screen.getByText(/Every record is marked/i)).toBeInTheDocument();
    // the mode string from GET /api/health is shown verbatim
    expect(await screen.findByText('mock-backend')).toBeInTheDocument();

    // the identity and the product explanation are present
    expect(screen.getByText('Tripwire')).toBeInTheDocument();
    expect(screen.getByText(/Every decision keeps the assumptions it was made on/i)).toBeInTheDocument();
  });

  it('renders the graph, its legend and the entity counts', async () => {
    await renderApp();

    const graphPanel = screen.getByTestId('graph-panel');
    // jsdom has no 2D canvas, so this is the real text fallback, not a mock
    expect(await within(graphPanel).findByTestId('graph-text-view')).toBeInTheDocument();
    expect(within(graphPanel).getByText(/Company knowledge graph/i)).toBeInTheDocument();
    expect(within(graphPanel).getByText(/Text view of the same graph/i)).toBeInTheDocument();

    // the legend doubles as the type filter and the state key
    expect(within(graphPanel).getByText(/Entities — click to show or hide/i)).toBeInTheDocument();
    expect(within(graphPanel).getByText(/Needs attention — ring on the node/i)).toBeInTheDocument();
    expect(within(graphPanel).getByText(/Decisive relationships/i)).toBeInTheDocument();

    // counts come from the backend payload
    expect(within(graphPanel).getByTestId('graph-counts').textContent).toMatch(/of 126 entities/);
  });

  it('starts in the baseline phase and shows an honest empty explanation', async () => {
    await renderApp();

    const scenario = screen.getByTestId('scenario-panel');
    expect(within(scenario).getByText('Baseline')).toBeInTheDocument();

    const decisions = screen.getByTestId('decision-panel');
    expect(await within(decisions).findByText(/All decisions \(9\)/)).toBeInTheDocument();

    const explanation = screen.getByTestId('explanation-panel');
    expect(within(explanation).getByText(/No decision is being explained yet/i)).toBeInTheDocument();
  });

  it('runs the Frankfurt scenario through the backend and shows the full chain', async () => {
    const { user } = await renderApp();
    const scenario = await runScenario(user);
    const decisions = screen.getByTestId('decision-panel');
    const explanation = screen.getByTestId('explanation-panel');

    // 1. the event and its verbatim source
    expect(
      within(scenario).getAllByText(/Our Frankfurt hosting partner has lost its EU compliance certification\./).length,
    ).toBeGreaterThan(0);
    // the panel reports that decisions were deliberately left alone
    expect(within(scenario).getByText(/Tripwire did not overreact/i)).toBeInTheDocument();

    // 2. affected decisions are grouped, and the unaffected stay visible
    expect(await within(decisions).findByText(/Flagged for review/i)).toBeInTheDocument();
    expect(
      within(decisions).getAllByText(/Proceed with the EU launch on the Frankfurt hosting plan/i).length,
    ).toBeGreaterThan(0);
    expect(within(decisions).getByText(/Uncertain — below the review threshold/i)).toBeInTheDocument();
    expect(within(decisions).getByText(/Unaffected \(/)).toBeInTheDocument();

    // 3. the explanation shows the causal chain, hop by hop, and why review is needed
    expect(
      await within(explanation).findByText(/depends on a certification the Frankfurt partner no longer holds/i),
    ).toBeInTheDocument();
    expect(within(explanation).getByText(/Evidence chain, fact by fact/i)).toBeInTheDocument();
    expect(within(explanation).getByText(/Why the backend flagged it/i)).toBeInTheDocument();
    expect(within(explanation).getByText(/In the backend's own words/i)).toBeInTheDocument();
    expect(
      within(explanation).getAllByText(/EU launch data must reside with an EU-certified processor/i).length,
    ).toBeGreaterThan(0);

    // 4. uncertainty and alternate evidence are first-class content
    expect(within(explanation).getByText(/Alternate evidence that must be weighed/i)).toBeInTheDocument();
    expect(within(explanation).getByText('FACT-PARTNER-STATUS-REVIEW')).toBeInTheDocument();

    // 5. the graph reports the highlighted chain
    const graphPanel = screen.getByTestId('graph-panel');
    expect(await within(graphPanel).findByText(/Chain highlighted/i)).toBeInTheDocument();
  });

  it('gates the guided storyline on what the backend can actually support', async () => {
    const { user } = await renderApp();
    const scenario = screen.getByTestId('scenario-panel');

    const before = within(scenario).getAllByRole('button', { name: /Run the scenario first/i });
    expect(before.length).toBeGreaterThanOrEqual(5);

    await runScenario(user);

    expect(within(scenario).queryAllByRole('button', { name: /Run the scenario first/i })).toHaveLength(0);
    expect(within(scenario).getByRole('button', { name: /Open the source message/i })).toBeEnabled();
    expect(within(scenario).getByRole('button', { name: /See who has done the work/i })).toBeEnabled();
    expect(within(scenario).getByRole('button', { name: /Step back in time/i })).toBeEnabled();
  });

  it('jumps to the matching panel when a storyline step is chosen', async () => {
    const { user } = await renderApp();
    const scenario = await runScenario(user);

    await user.click(within(scenario).getByRole('button', { name: /See who has done the work/i }));

    expect(await screen.findByRole('heading', { name: /Who has done the work/i })).toBeInTheDocument();
    expect((await screen.findAllByText(/Lukas Meyer/i)).length).toBeGreaterThan(0);
    // the ranking must expose its own limitations
    expect((await screen.findAllByText(/Contribution counts only/i)).length).toBeGreaterThan(0);
  });

  it('resets the demo back to the baseline graph', async () => {
    const { user } = await renderApp();
    const scenario = await runScenario(user);
    const decisions = screen.getByTestId('decision-panel');

    expect(await within(decisions).findByText(/Flagged for review/i)).toBeInTheDocument();

    await user.click(within(scenario).getByRole('button', { name: /Reset demo/i }));

    expect(await within(scenario).findByText('Baseline')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(decisions).getByText(/All decisions \(9\)/)).toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId('explanation-panel')).getByText(/No decision is being explained yet/i),
    ).toBeInTheDocument();
  });

  it('explains a decision from the list and states honestly when nothing challenges it', async () => {
    const { user } = await renderApp();
    const decisions = screen.getByTestId('decision-panel');
    const explanation = screen.getByTestId('explanation-panel');

    // baseline: the backend answers that no contradiction reaches this decision
    const explainButtons = await within(decisions).findAllByRole('button', { name: 'Explain' });
    expect(explainButtons.length).toBeGreaterThan(0);
    await user.click(explainButtons[0]);

    await waitFor(() => {
      expect(within(explanation).getByText(/Nothing is challenging this decision/i)).toBeInTheDocument();
    });
    expect(within(explanation).getByText(/No contradiction reaches this decision/i)).toBeInTheDocument();
    expect(within(explanation).getByText(/Stated uncertainty/i)).toBeInTheDocument();
    expect(within(explanation).getAllByText(/recorded state of the graph/i).length).toBeGreaterThan(0);
  });

  it('explains a decision with the full chain once a fact has actually been contradicted', async () => {
    const { user } = await renderApp();
    await runScenario(user);

    const decisions = screen.getByTestId('decision-panel');
    const explainButtons = within(decisions).getAllByRole('button', { name: 'Explain' });
    await user.click(explainButtons[0]);

    const explanation = screen.getByTestId('explanation-panel');
    await waitFor(() => {
      expect(within(explanation).getByText(/Evidence chain, fact by fact/i)).toBeInTheDocument();
    });
    expect(within(explanation).getAllByText('DEC-EU-LAUNCH').length).toBeGreaterThan(0);
  });

  it('filters the graph by entity type without inventing entities', async () => {
    const { user } = await renderApp();
    const graphPanel = screen.getByTestId('graph-panel');
    const legend = within(graphPanel).getByTestId('graph-legend');
    const counts = () => within(graphPanel).getByTestId('graph-counts').textContent ?? '';

    const before = counts();
    await user.click(within(legend).getByRole('button', { name: /^Fact\b/ }));

    expect(counts()).not.toBe(before);
    expect(within(graphPanel).getByText(/filters applied/i)).toBeInTheDocument();
    // hidden entities are stated honestly rather than silently dropped
    expect(within(graphPanel).getByTestId('graph-counts').textContent).toMatch(/of 126 entities/);
  });

  it('keeps at least one entity type visible so the graph cannot be emptied by accident', async () => {
    const { user } = await renderApp();
    const graphPanel = screen.getByTestId('graph-panel');
    const legend = within(graphPanel).getByTestId('graph-legend');

    const typeButtons = within(legend).getAllByRole('button');
    expect(typeButtons.length).toBeGreaterThan(1);

    for (const button of typeButtons.slice(0, typeButtons.length - 1)) {
      await user.click(button);
    }

    const stillPressed = within(legend)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(stillPressed).toHaveLength(1);
    expect(within(graphPanel).queryByText(/Nothing matches the current filters/i)).not.toBeInTheDocument();
  });

  it('shows source evidence with an explicit simulated-data warning and distinct provenance levels', async () => {
    const { user } = await renderApp();
    await runScenario(user);

    await user.click(screen.getByRole('tab', { name: /Evidence/i }));

    expect(await screen.findByText(/Source evidence/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/Simulated/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Original source/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/System interpretation/i)).length).toBeGreaterThan(0);
  });

  it('lets the operator step back in recorded time', async () => {
    const { user, view } = await renderApp();

    await user.click(screen.getByRole('tab', { name: /History/i }));

    expect((await screen.findAllByText(/What the company believed, and when/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/never re-stamps today's graph onto the past/i)).toBeInTheDocument();

    const dateInput = view.container.querySelector('input[type="date"]');
    expect(dateInput).not.toBeNull();
    expect((dateInput as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('surfaces the raised alert for review once the event is applied', async () => {
    const { user } = await renderApp();
    await runScenario(user);

    await user.click(screen.getByRole('tab', { name: /Alerts/i }));
    expect(await screen.findByText(/ALERT-0001/)).toBeInTheDocument();
  });

  it('never claims a review was recorded before the backend confirms it', async () => {
    const { user } = await renderApp();
    await runScenario(user);

    await user.click(screen.getByRole('tab', { name: /Alerts/i }));
    expect(await screen.findByText('ALERT-0001')).toBeInTheDocument();

    // the review control states plainly, on every alert, that the change shows only
    // after the backend confirms it — there is no optimistic update anywhere
    expect(screen.getAllByText(/nothing here is changed optimistically/i).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/Review note/i).length).toBeGreaterThan(0);
    // and it offers only transitions the backend will accept
    expect(screen.getAllByRole('button', { name: /Assign for review/i }).length).toBeGreaterThan(0);
  });
});
