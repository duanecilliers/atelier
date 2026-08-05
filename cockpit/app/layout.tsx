import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { CommandPalette } from '@/components/CommandPalette';
import { NAV_ALL } from '@/lib/nav';
import type { Command } from '@/lib/palette';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'ATELIER',
  description: 'Operator console over the SSSF engine — agents propose, code disposes',
};

// Palette commands are derived from the nav (single source of truth), so the
// shell stays decoupled from the db — a missing sssf.db never 500s the chrome,
// only the views that actually read it.
const NAV_COMMANDS: Command[] = NAV_ALL.map((n) => ({
  id: `nav-${n.href}`,
  label: n.label,
  keywords: `${n.href} view ${n.live === false ? 'soon phase' : ''}`,
  href: n.href,
  hint: 'view',
}));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontMono.variable} suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before first paint — no flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Sidebar />
        <div className="ml-[232px] flex min-h-screen min-w-0 flex-col">
          <Topbar />
          <main className="min-w-0 flex-1 px-8 pb-16 pt-7 wide:px-10 ultra:px-12">
            <div className="mx-auto max-w-[1280px] wide:max-w-[1760px] ultra:max-w-none">{children}</div>
          </main>
        </div>
        <CommandPalette commands={NAV_COMMANDS} />
      </body>
    </html>
  );
}
