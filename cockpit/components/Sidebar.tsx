'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_OPERATE, NAV_FACTORY, NAV_OBSERVE, type NavItem } from '@/lib/nav';
import { AtelierMark } from '@/components/AtelierMark';

function NavGroup({ title, items, pathname }: { title: string; items: NavItem[]; pathname: string }) {
  return (
    <>
      <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-[9px] uppercase tracking-[0.18em] text-os-dim">
        {title}
      </div>
      {items.map(({ href, label, icon: Icon, live }) => {
        const active = pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
        return (
          <Link
            key={href}
            href={href}
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

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[232px] flex-col border-r border-os-border bg-os-bg2">
      <div className="flex items-center gap-[11px] px-[18px] pb-[18px] pt-5">
        <AtelierMark size={34} className="shrink-0" />
        <div>
          <div className="text-[13px] font-bold tracking-[0.14em]">ATELIER</div>
          <div className="mt-[3px] whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.16em] text-os-dim">
            Observe · v0
          </div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2">
        <NavGroup title="Operate" items={NAV_OPERATE} pathname={pathname} />
        <NavGroup title="Factory" items={NAV_FACTORY} pathname={pathname} />
        <NavGroup title="Observe" items={NAV_OBSERVE} pathname={pathname} />
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
