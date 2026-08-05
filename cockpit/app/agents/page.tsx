import { getDb } from '@/lib/data';
import { readRoster, rosterWarnings } from '@/lib/roster';
import { RosterEditor } from '@/components/agents/RosterEditor';
import type { AgentTelemetry } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * /agents — the roster view + editor (Phase 4, authoring). Reads the factory's
 * own agent roster from sssf.config.yaml (see lib/roster.ts) and enriches each
 * agent with what it actually did last, from agent_sessions. Editing the
 * allowlisted scalar fields POSTs a surgical patch back to /api/roster — the
 * first config-write surface, kept inside the determinism spine (it writes a
 * config file, never a run's trace and never a process).
 */
function load(): {
  roster: ReturnType<typeof readRoster> | null;
  telemetry: Record<string, AgentTelemetry>;
  warnings: ReturnType<typeof rosterWarnings>;
  error: string | null;
} {
  try {
    const roster = readRoster();
    // Map → plain record so it crosses the server/client boundary as props.
    const telemetry = Object.fromEntries(getDb().agentTelemetry());
    return { roster, telemetry, warnings: rosterWarnings(roster), error: null };
  } catch (e) {
    return { roster: null, telemetry: {}, warnings: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default function AgentsPage() {
  const { roster, telemetry, warnings, error } = load();

  return (
    <div className="view">
      <p className="mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">Atelier</p>
      <h1 className="mb-1 text-[28px] font-bold uppercase tracking-[0.06em]">Agents</h1>
      <p className="mb-6 max-w-[64ch] text-[13px] text-os-muted">
        The factory&apos;s roster, read live from <code className="text-os-dim">sssf.config.yaml</code> and
        enriched with each agent&apos;s last run. Edit a model, backend, thinking level, color, purpose, tools or
        writes — or add and remove agents entirely. Every change is written straight back to the config,
        comments and all.
      </p>

      {error ? (
        <pre className="whitespace-pre-wrap border border-os-err/40 p-4 font-mono text-[11.5px] text-os-muted">
          {error}
        </pre>
      ) : !roster || roster.agents.length === 0 ? (
        <div className="border border-dashed border-os-border-strong px-4 py-5 font-mono text-[11.5px] text-os-dim">
          No agents configured. Add some to the <code>agents:</code> list in sssf.config.yaml.
        </div>
      ) : (
        <RosterEditor roster={roster} telemetry={telemetry} warnings={warnings} now={Date.now()} />
      )}
    </div>
  );
}
