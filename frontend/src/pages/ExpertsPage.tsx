/**
 * Expert Intelligence — contribution-based ranking from `GET /api/experts`.
 * The page keeps the backend's own distinction between the *listed owner* of a
 * system and the people who actually did the recorded work ("shadow" experts).
 */

import type { ShellContext } from '../App';
import { Callout, Panel, PanelBody, PanelHead } from '../components/common';
import { IconUser } from '../components/common/Icons';
import { ExpertPanel } from '../components/people/ExpertPanel';

export function ExpertsPage({ ctx }: { ctx: ShellContext }) {
  const { tw } = ctx;

  return (
    <div className="stack stack--loose experts-page">
      <Callout tone="info" title="Contribution beats org chart">
        Experts are ranked on recorded contributions — authored sources, resolved tickets, review
        activity — not on who is listed as the owner. A person can be the deepest expert on a system
        they do not own; that is a shadow signal, and Tripwire surfaces it explicitly.
      </Callout>

      <Panel>
        <PanelHead
          icon={<IconUser size={17} />}
          title="Who has done the work"
          subtitle={
            tw.capabilities?.expertsQuery
              ? 'Ranked on recorded contribution. The backend resolves the target from free text, so search for a system, project or topic.'
              : 'Ranked on recorded contribution to the affected system.'
          }
        />
        <PanelBody tight>
          {tw.capabilities?.expertsQuery ? (
            <label className="stack stack--tight">
              <span className="tiny muted">Search for a system, project or decision</span>
              <input
                type="search"
                className="app__select"
                value={tw.expertsQuery}
                onChange={(event) => tw.setExpertsQuery(event.target.value)}
                placeholder="e.g. Frankfurt Hosting Partner"
                aria-label="Search for who has worked on a system, project or decision"
              />
              <span className="tiny muted">
                Sent as <span className="mono">GET /api/experts?q=…</span>
              </span>
            </label>
          ) : (
            <label className="stack stack--tight">
              <span className="tiny muted">System to rank expertise for</span>
              <select
                className="app__select"
                value={''}
                onChange={() => undefined}
                aria-label="System to rank expertise for"
              >
                <option value="">Default for the current scenario</option>
                {(tw.systems.data?.systems ?? []).map((system) => (
                  <option key={system.id} value={system.id}>
                    {system.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </PanelBody>
      </Panel>

      <ExpertPanel
        response={tw.experts.data}
        loading={tw.experts.loading}
        error={tw.experts.error}
        onSelectPerson={ctx.inspectNode}
      />
    </div>
  );
}
