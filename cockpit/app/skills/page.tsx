import { readRecipes, type Recipe } from '@/lib/skills';
import { Badge, Label } from '@/components/terminal';

export const dynamic = 'force-dynamic';

/**
 * /skills — the cookbook. A read-only card grid of the factory's own recipes: the
 * `engine/adws/adw_*.py` scripts, each a fixed chain of phases the agents compose.
 * Read live from disk (see lib/skills.ts), never from the db — these are source,
 * not trace. Pure observe, like everything on the read path.
 */
function load(): { recipes: Recipe[]; error: string | null } {
  try {
    return { recipes: readRecipes(), error: null };
  } catch (e) {
    return { recipes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default function SkillsPage() {
  const { recipes, error } = load();

  return (
    <div className="view">
      <p className="mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">Atelier</p>
      <h1 className="mb-1 text-[28px] font-bold uppercase tracking-[0.06em]">Skills</h1>
      <p className="mb-6 max-w-[64ch] text-[13px] text-os-muted">
        The factory&apos;s cookbook, read live from{' '}
        <code className="text-os-dim">engine/adws/adw_*.py</code>. Each recipe is one ADW — a fixed
        chain of phases where an engineer states intent, an agent proposes, and deterministic code
        disposes. This is the capability library the agents draw on.
      </p>

      {error ? (
        <pre className="whitespace-pre-wrap border border-os-err/40 p-4 font-mono text-[11.5px] text-os-muted">
          {error}
        </pre>
      ) : recipes.length === 0 ? (
        <div className="border border-dashed border-os-border-strong px-4 py-5 font-mono text-[11.5px] text-os-dim">
          No recipes found. The cockpit reads them from the engine&apos;s <code>adws/</code> directory
          — check <code>SSSF_ADWS_DIR</code>.
        </div>
      ) : (
        <>
          <div className="mb-3">
            <Label count={recipes.length} rule>
              Recipes
            </Label>
          </div>
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
            {recipes.map((r) => (
              <RecipeCard key={r.id} recipe={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <div className="flex h-full flex-col border border-os-border bg-os-bg p-4">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[15px] font-bold uppercase tracking-[0.06em] text-os-text">
          {recipe.name}
        </h2>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-os-dim">
          {recipe.steps.length} phase{recipe.steps.length === 1 ? '' : 's'}
        </span>
      </div>

      {recipe.tagline && <p className="mb-3 text-[12.5px] text-os-muted">{recipe.tagline}</p>}

      <PhaseFlow steps={recipe.steps} />

      {recipe.detail.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {recipe.detail.map((p, i) => (
            <p key={i} className="text-[11.5px] leading-relaxed text-os-dim">
              {p}
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-os-hairline pt-3">
        <AgentPills agents={recipe.agents} />
        <code className="shrink-0 font-mono text-[10px] text-os-dim">{recipe.file}</code>
      </div>
    </div>
  );
}

/** The phase chain as chips. A step's `[…]` bounded-loop annotation recedes to a
 *  muted suffix so the main pipeline reads at a glance while staying faithful. */
function PhaseFlow({ steps }: { steps: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 font-mono text-[11px]">
      {steps.map((step, i) => {
        const br = step.indexOf('[');
        const primary = (br < 0 ? step : step.slice(0, br)).trim();
        const loop = br < 0 ? '' : step.slice(br).trim().replace(/->/g, '→');
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-os-dim">→</span>}
            <span className="rounded-sm-t border border-os-border-strong px-1.5 py-[3px] text-os-text">
              {primary && <span>{primary}</span>}
              {loop && <span className={primary ? 'ml-1.5 text-os-dim' : 'text-os-dim'}>{loop}</span>}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** The recipe's roster: required agents as pills, or the null/empty semantics. */
function AgentPills({ agents }: { agents: string[] | null }) {
  if (agents === null) {
    return <Badge ghost>agent per run</Badge>;
  }
  if (agents.length === 0) {
    return <Badge ghost>deterministic</Badge>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {agents.map((a) => (
        <Badge key={a} tone="accent">
          {a}
        </Badge>
      ))}
    </div>
  );
}
