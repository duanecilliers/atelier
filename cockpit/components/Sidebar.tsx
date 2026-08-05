'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { NAV_OPERATE, NAV_FACTORY, NAV_OBSERVE, type NavItem } from '@/lib/nav';
import { projectHref } from '@/lib/project-url';
import { AtelierMark } from '@/components/AtelierMark';

/** The switcher UX for the shell (Part E). id + name only — the registry's roots
 *  never cross to the client. Navigating swaps to the other project's runs view. */
export type ProjectOption = { id: string; name: string };

function NavGroup({
  title,
  items,
  pathname,
  projectId,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  projectId: string;
}) {
  return (
    <>
      <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-[9px] uppercase tracking-[0.18em] text-os-dim">
        {title}
      </div>
      {items.map(({ href, label, icon: Icon, live }) => {
        const target = projectHref(projectId, href);
        // Active when the path is this view or a child of it. The project root
        // (href '/') must match ONLY the exact project path, never every child.
        const active = href === '/' ? pathname === target : pathname === target || pathname.startsWith(`${target}/`);
        return (
          <Link
            key={href}
            href={target}
            className={`flex items-center gap-2.5 rounded-sm-t border px-2.5 py-[7px] text-[13.5px] font-medium transition-colors ${
              active
                ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-os-accent'
                : 'border-transparent text-os-muted hover:bg-os-surface2 hover:text-os-text'
            }`}
          >
            <Icon className="h-[15px] w-[15px] shrink-0 opacity-85" strokeWidth={1.7} />
            <span className="flex-1">{label}</span>
            {/* IA is real even before the view is — tag the not-yet-live ones. */}
            {live === false && (
              <span className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-os-dim">soon</span>
            )}
          </Link>
        );
      })}
    </>
  );
}

/** The project switcher: a native select styled to the shell. Navigates to the
 *  chosen project's runs view. Single-project (env fallback) still renders, so
 *  the current project is always named. */
function ProjectSwitcher({ projects, projectId }: { projects: ProjectOption[]; projectId: string }) {
  const router = useRouter();
  return (
    <label className="relative block">
      <span className="sr-only">Project</span>
      <select
        value={projectId}
        onChange={(e) => router.push(projectHref(e.target.value, '/'))}
        className="w-full cursor-pointer appearance-none rounded-sm-t border border-os-border bg-os-surface py-[7px] pl-2.5 pr-7 font-mono text-[12px] text-os-text outline-none transition-colors hover:border-os-border-strong focus:border-os-border-strong"
        aria-label="Switch project"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {/* caret */}
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-os-dim">
        ▾
      </span>
    </label>
  );
}

export function Sidebar({ projects, projectId }: { projects: ProjectOption[]; projectId: string }) {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[232px] flex-col border-r border-os-border bg-os-bg2">
      <div className="flex items-center gap-[11px] px-[18px] pb-3 pt-5">
        <AtelierMark size={34} className="shrink-0" />
        <div>
          <div className="text-[13px] font-bold tracking-[0.14em]">ATELIER</div>
          <div className="mt-[3px] whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.16em] text-os-dim">
            Observe · v0
          </div>
        </div>
      </div>
      <div className="px-2.5 pb-1">
        <ProjectSwitcher projects={projects} projectId={projectId} />
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2">
        <NavGroup title="Operate" items={NAV_OPERATE} pathname={pathname} projectId={projectId} />
        <NavGroup title="Factory" items={NAV_FACTORY} pathname={pathname} projectId={projectId} />
        <NavGroup title="Observe" items={NAV_OBSERVE} pathname={pathname} projectId={projectId} />
      </nav>
      <div className="flex flex-col gap-2 border-t border-os-border px-[18px] py-3.5">
        <div className="flex items-center gap-2 whitespace-nowrap font-mono text-[10px] text-os-muted">
          <span className="dot ok pulse" /> reading sssf.db
        </div>
        <div className="whitespace-nowrap font-mono text-[10px] text-os-dim">
          sqlite · WAL · read-only
        </div>
      </div>
    </aside>
  );
}
