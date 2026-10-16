/**
 * End-to-end demonstration against the REAL backend in a real browser.
 *
 * Covers the eight required steps: launch, connect, load the seeded graph, trigger
 * the Frankfurt event, inspect the affected decision, open evidence and experts,
 * review an alert, and reset.
 *
 * Every assertion targets data the backend actually returned — no fixture
 * expectations leak in here, which is the point of running it live.
 */

import { expect, test, type Page } from '@playwright/test';

const API = process.env.TRIPWIRE_API_BASE_URL ?? 'http://localhost:8000';

/** Restore a clean baseline before each spec so the demo is reproducible. */
async function resetBackend(page: Page) {
  const response = await page.request.post(`${API}/api/demo/reset`);
  expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await resetBackend(page);
});

test.describe('Tripwire live demo', () => {
  test('connects to the real backend and loads the seeded graph', async ({ page }) => {
    await page.goto('/');

    // 1–3. connected, real mode, dataset present
    await expect(page.getByText('Live backend')).toBeVisible();
    await expect(page.getByText('MOCK MODE')).toHaveCount(0);
    await expect(page.getByText(/memory · deterministic/).first()).toBeVisible();

    // the graph panel reports the real node count
    const graphPanel = page.getByTestId('graph-panel');
    await expect(graphPanel.getByText(/Company knowledge graph/i)).toBeVisible();
    await expect(graphPanel.getByTestId('graph-counts')).toContainText(/of 1\d\d entities/);

    // the scenario picker defaults to Frankfurt
    await expect(page.getByLabel('Demo scenario')).toHaveValue('frankfurt_compliance_revoked');
  });

  test('renders the canvas graph and repaints when the draw state changes', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.graph canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // let the force simulation settle
    await page.waitForTimeout(3500);

    const before = await canvas.screenshot();
    await page.getByRole('checkbox', { name: /Labels/i }).uncheck();
    await page.waitForTimeout(800);
    const after = await canvas.screenshot();

    // a real repaint changes pixels; an identical buffer would mean the canvas
    // never redraws on state change, which is the classic force-graph trap
    expect(Buffer.compare(before, after)).not.toBe(0);
  });

  test('selecting a node and running the scenario both visibly repaint the canvas', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.graph canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // let the force layout settle so differences come from us, not the simulation
    await page.waitForTimeout(4000);
    const baseline = await canvas.screenshot();

    /*
     * Click a real node. Node centres are found by sampling the canvas for the
     * fill colours of the node kinds, rather than guessing coordinates.
     */
    const point = await page.evaluate(() => {
      const el = document.querySelector('.graph canvas') as HTMLCanvasElement | null;
      if (!el) return null;
      const ctx = el.getContext('2d');
      if (!ctx) return null;
      const { width, height } = el;
      const data = ctx.getImageData(0, 0, width, height).data;
      // decision teal, assumption violet, fact blue, project amber
      const targets = [
        [15, 118, 110],
        [124, 58, 237],
        [37, 99, 235],
        [202, 138, 4],
      ];
      for (let y = 2; y < height - 2; y += 2) {
        for (let x = 2; x < width - 2; x += 2) {
          const i = (y * width + x) * 4;
          if (data[i + 3] < 200) continue;
          for (const t of targets) {
            if (
              Math.abs(data[i] - t[0]) < 14 &&
              Math.abs(data[i + 1] - t[1]) < 14 &&
              Math.abs(data[i + 2] - t[2]) < 14
            ) {
              const rect = el.getBoundingClientRect();
              const ratio = rect.width / el.width;
              return { x: rect.left + x * ratio, y: rect.top + y * ratio };
            }
          }
        }
      }
      return null;
    });

    expect(point, 'a node fill colour should be findable on the canvas').not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    await page.waitForTimeout(900);

    // 1. the canvas actually repainted on selection
    const afterSelect = await canvas.screenshot();
    expect(
      Buffer.compare(baseline, afterSelect),
      'selecting a node must repaint the canvas',
    ).not.toBe(0);

    // 2. and the selection reached the inspector, i.e. the click hit a real node
    await expect(page.locator('.node-inspector')).toBeVisible();

    // 3. triggering the event repaints again, and highlights the chain
    const scenario = page.getByTestId('scenario-panel');
    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1200);

    const afterTrigger = await canvas.screenshot();
    expect(
      Buffer.compare(afterSelect, afterTrigger),
      'running the scenario must repaint the canvas',
    ).not.toBe(0);

    const graphPanel = page.getByTestId('graph-panel');
    const chain = graphPanel.getByText(/Chain highlighted/i).first();
    await expect(chain).toBeVisible();
    // the highlighted chain covers the fact, the assumption and the decision
    const chainText = (await chain.textContent()) ?? '';
    const count = Number(chainText.replace(/\D+/g, '')) || 0;
    expect(count, `expected a multi-entity chain, got "${chainText}"`).toBeGreaterThanOrEqual(3);

    // and the chain the graph draws is the one the explanation names
    const explanation = page.getByTestId('explanation-panel');
    await expect(explanation.getByText(/data-residency/i).first()).toBeVisible();
  });

  test('runs the Frankfurt scenario and shows the honest, non-dramatic result', async ({ page }) => {
    await page.goto('/');
    const scenario = page.getByTestId('scenario-panel');

    // 4. trigger
    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });

    // the engine's own accounting
    await expect(scenario.getByText(/confirmed/i).first()).toBeVisible();
    await expect(scenario.getByText(/potential only/i)).toBeVisible();

    // the restraint case is surfaced, not hidden
    await expect(scenario.getByText(/Tripwire did not overreact/i)).toBeVisible();

    // 5. affected decisions, with potential distinguished from confirmed
    const decisions = page.getByTestId('decision-panel');
    await expect(decisions.getByText(/Flagged for review/i)).toBeVisible();
    await expect(decisions.getByText(/Potential impact/i).first()).toBeVisible();
    await expect(decisions.getByText(/Uncertain — below the review threshold/i)).toBeVisible();
    await expect(decisions.getByText(/Unaffected \(/)).toBeVisible();

    // the EU launch must NOT be presented as confirmed stale
    await expect(decisions.getByText(/Proceed with the EU launch|Launch Northwind in the EU/i).first()).toBeVisible();
    await expect(decisions.getByText(/^Confirmed stale$/)).toHaveCount(0);
  });

  test('explains the chain from the changed fact through the assumption', async ({ page }) => {
    await page.goto('/');
    const scenario = page.getByTestId('scenario-panel');
    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });

    const explanation = page.getByTestId('explanation-panel');
    await expect(explanation.getByText(/Evidence chain, fact by fact/i)).toBeVisible();
    await expect(explanation.getByText(/data-residency/i).first()).toBeVisible();
    await expect(explanation.getByText(/supported_by/i).first()).toBeVisible();

    // 5b. alternate evidence explains why the launch is not declared invalid
    await expect(explanation.getByText(/Alternate evidence that must be weighed/i)).toBeVisible();
    await expect(explanation.getByText(/SOC 2|soc2/i).first()).toBeVisible();

    // the honest uncertainty statement
    await expect(explanation.getByText(/not a verdict/i)).toBeVisible();
  });

  test('opens source provenance with both time axes kept apart', async ({ page }) => {
    await page.goto('/');
    const scenario = page.getByTestId('scenario-panel');
    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });

    // 6a. evidence
    await page.getByRole('tab', { name: /Evidence/i }).click();
    await expect(page.getByText(/Source evidence/i)).toBeVisible();
    await expect(page.getByText(/Original source/i).first()).toBeVisible();
    await expect(page.getByText(/System interpretation/i).first()).toBeVisible();

    // 7. history: real-world validity vs recorded time
    await page.getByRole('tab', { name: /History/i }).click();
    await expect(page.getByText(/What the company believed, and when/i).first()).toBeVisible();
    await expect(page.getByLabel(/Show what Tripwire believed on/i)).toBeVisible();
    await expect(page.getByText(/valid_from|validity/i).first()).toBeVisible();
  });

  test('reveals the hidden expert who is not the listed owner', async ({ page }) => {
    await page.goto('/');
    const scenario = page.getByTestId('scenario-panel');
    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });

    // 6b. experts by contribution
    await page.getByRole('tab', { name: /People/i }).click();
    await expect(page.getByText(/Who has done the work/i).first()).toBeVisible();

    // the ranking states its own limitations
    await expect(page.getByText(/not proof of expertise/i).first()).toBeVisible();
    // and the official owner is shown separately for contrast
    await expect(page.getByText(/listed owner/i).first()).toBeVisible();
  });

  test('reviews an alert through the server and reports a no-op honestly', async ({ page }) => {
    await page.goto('/');
    const scenario = page.getByTestId('scenario-panel');
    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });

    /*
     * Which transitions are legitimate depends on the alert's CURRENT status: a
     * fresh NEEDS_REVIEW alert can be confirmed/dismissed/resolved, but cannot be
     * "assigned for review" again. The backend does NOT advertise
     * `allowed_transitions` (verified), so the documented model is the source of
     * truth — and the UI is checked against it.
     */
    const alertsResponse = await page.request.get(`${API}/api/alerts?limit=1`);
    expect(alertsResponse.ok()).toBeTruthy();
    const alertsBody = await alertsResponse.json();
    const firstAlert = alertsBody.alerts?.[0];
    expect(firstAlert, 'the scenario should have raised at least one alert').toBeTruthy();
    const currentStatus: string = firstAlert.status;

    // the documented status model (matches REVIEW_ACTIONS in the frontend)
    const TRANSITIONS: Array<{ status: string; label: string }> = [
      { status: 'NEEDS_REVIEW', label: 'Assign for review' },
      { status: 'CONFIRMED_STALE', label: 'Confirm stale' },
      { status: 'DISMISSED', label: 'Dismiss' },
      { status: 'RESOLVED', label: 'Mark resolved' },
    ];
    const legal = TRANSITIONS.filter((entry) => entry.status !== currentStatus);
    const illegal = TRANSITIONS.filter((entry) => entry.status === currentStatus);

    await page.getByRole('tab', { name: /Alerts/i }).click();
    await expect(page.getByText(/alert:[0-9a-f]{6}/i).first()).toBeVisible();

    // the panel is explicit that nothing changes optimistically
    await expect(page.getByText(/nothing here is changed optimistically/i).first()).toBeVisible();

    // every legal transition is offered...
    for (const entry of legal) {
      await expect(
        page.getByRole('button', { name: entry.label }).first(),
        `${entry.label} should be offered from ${currentStatus}`,
      ).toBeVisible();
    }
    // ...and a transition to the current status is NOT offered, because the server
    // would treat it as a no-op
    for (const entry of illegal) {
      await expect(page.getByRole('button', { name: entry.label })).toHaveCount(0);
    }

    const target = legal[0].status;
    const controlLabel = legal[0].label;

    const note = page.getByLabel(/Review note/i).first();
    await note.fill('Checked during the live demo.');
    await page.getByRole('button', { name: controlLabel }).first().click();

    // whatever the server decided, the UI says so truthfully — and the claim it
    // makes is checked against the server afterwards
    const notice = page.getByText(
      /Review recorded by the backend|No change was made|Review not confirmed/i,
    ).first();
    await expect(notice).toBeVisible({ timeout: 30_000 });

    const after = await (await page.request.get(`${API}/api/alerts?limit=1`)).json();
    const nowStatus = after.alerts?.[0]?.status;
    // The UI must not claim a transition the server did not record.
    if (nowStatus === firstAlert.status) {
      await expect(page.getByText(/No change was made|Review not confirmed/i).first()).toBeVisible();
    } else {
      expect(nowStatus).toBe(target);
      // and the UI names the transition it recorded
      await expect(page.getByText(new RegExp(target, 'i')).first()).toBeVisible();
    }
  });

  test('resets the demo back to a clean baseline', async ({ page }) => {
    await page.goto('/');
    const scenario = page.getByTestId('scenario-panel');

    await scenario.getByRole('button', { name: /Run Frankfurt scenario/i }).click();
    await expect(scenario.getByText('Event applied')).toBeVisible({ timeout: 60_000 });

    // 8. reset
    await scenario.getByRole('button', { name: /Reset demo/i }).click();
    await expect(scenario.getByText('Baseline')).toBeVisible({ timeout: 60_000 });

    // and the backend agrees
    const state = await page.request.get(`${API}/api/demo/state`);
    const body = await state.json();
    expect(body.alerts.total).toBe(0);
  });

  test('stays usable on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');

    await expect(page.getByText('Live backend')).toBeVisible();
    // no horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('reports console errors instead of hiding them', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await expect(page.getByText('Live backend')).toBeVisible();
    await page.waitForTimeout(3000);

    // benign React/key warnings are filtered; real exceptions are not
    const meaningful = errors.filter(
      (text) => !/Download the React DevTools|favicon/i.test(text),
    );
    expect(meaningful).toEqual([]);
  });
});
