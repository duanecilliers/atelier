/**
 * Single source of truth for Atelier's navigation. The Sidebar renders these
 * groups in order; the CommandPalette derives its digit (1–9) shortcuts from the
 * same visible order, so the two can never drift.
 *
 * Re-pointed from FounderOS's business views to the engine concepts from the
 * plan's concept map (§03): a Run is one ADW session; the Process Map lives
 * inside a run's detail; Agents/Skills are the factory; Gates/Cost are how you
 * measure it. `live: false` marks a view that ships in a later phase — the
 * Sidebar still lists it (the IA is real) but tags it so nothing pretends to
 * work before it does.
 */
import {
  Activity,
  ListChecks,
  Boxes,
  Bot,
  Sparkles,
  ShieldCheck,
  Receipt,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  live?: boolean;
};

// The runs and the queue that feeds them.
export const NAV_OPERATE: NavItem[] = [
  {
    href: '/',
    label: 'Runs',
    icon: Activity,
    description: 'All ADW runs - live and historical traces',
    live: true,
  },
  {
    href: '/queue',
    label: 'Queue',
    icon: ListChecks,
    description: 'Launch queue - runs waiting for the worker',
    live: true,
  }, // Phase 2 — control plane
  {
    href: '/sandboxes',
    label: 'Sandboxes',
    icon: Boxes,
    description: 'Isolated worktree workspaces hosting runs',
    live: true,
  }, // Phase 5 — isolated persistent workspaces
];

// The factory: the agents that propose and the skills they draw on.
export const NAV_FACTORY: NavItem[] = [
  {
    href: '/agents',
    label: 'Agents',
    icon: Bot,
    description: 'The roster - configured agents and their models',
    live: true,
  }, // Phase 4 — roster view + editor
  {
    href: '/skills',
    label: 'Skills',
    icon: Sparkles,
    description: 'Skill cookbooks the agents draw on',
    live: true,
  }, // Phase 4 — cookbook (read-only)
];

// How you measure it: the deterministic gates and what each run cost.
export const NAV_OBSERVE: NavItem[] = [
  {
    href: '/gates',
    label: 'Gates',
    icon: ShieldCheck,
    description: 'Deterministic acceptance checks per run',
  }, // Phase 3
  {
    href: '/cost',
    label: 'Cost',
    icon: Receipt,
    description: 'Token and dollar spend per run and agent',
  }, // Phase 3
];

/** Visible top-to-bottom order across all groups. */
export const NAV_ORDER: string[] = [...NAV_OPERATE, ...NAV_FACTORY, ...NAV_OBSERVE].map((n) => n.href);

/** Digit keys 1–9 jump to the first nine views in visible order. */
export const DIGIT_VIEWS: string[] = NAV_ORDER.slice(0, 9);

/** Flat list, for building command-palette entries. */
export const NAV_ALL: NavItem[] = [...NAV_OPERATE, ...NAV_FACTORY, ...NAV_OBSERVE];
