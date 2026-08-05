import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';
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

// The shell (sidebar, topbar, command palette) lives in app/[project]/layout.tsx
// — it needs the project segment to key the db and drive the switcher. The root
// layout stays chrome-free: fonts, theme, and the html/body skeleton, so the
// bare-root redirect (app/page.tsx) never pays for the shell.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontMono.variable} suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before first paint — no flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
