import { notFound } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { CommandPalette } from '@/components/CommandPalette';
import { NAV_ALL } from '@/lib/nav';
import type { Command } from '@/lib/palette';
import { getProjects } from '@/lib/projects';

// The project-scoped shell. Everything below the root html/body renders here so
// the sidebar switcher, topbar breadcrumb, and command palette all know which
// project they're in. force-dynamic so the registry (atelier.projects.json) is
// re-read per request — a newly-added project appears without a rebuild.
export const dynamic = 'force-dynamic';

// Palette commands are derived from the nav (single source of truth); the
// CommandPalette prefixes each href with the current project at navigation time,
// so these stay project-agnostic. A missing sssf.db never 500s the chrome — only
// the views that actually read it.
const NAV_COMMANDS: Command[] = NAV_ALL.map((n) => ({
  id: `nav-${n.href}`,
  label: n.label,
  keywords: `${n.href} view ${n.live === false ? 'soon phase' : ''}`,
  href: n.href,
  hint: 'view',
}));

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { project: string };
}) {
  const projects = getProjects();
  const current = projects.find((p) => p.id === params.project);
  // An unknown project id is a 404, not a silent read of the wrong (or default) db.
  if (!current) notFound();

  // Only the switcher's shape crosses to the client — id + name, never the roots.
  const projectList = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <>
      <Sidebar projects={projectList} projectId={current.id} />
      <div className="ml-[232px] flex min-h-screen min-w-0 flex-col">
        <Topbar />
        <main className="min-w-0 flex-1 px-8 pb-16 pt-7 wide:px-10 ultra:px-12">
          <div className="mx-auto max-w-[1280px] wide:max-w-[1760px] ultra:max-w-none">{children}</div>
        </main>
      </div>
      <CommandPalette commands={NAV_COMMANDS} />
    </>
  );
}
