import './globals.css';
import type { Metadata } from 'next';
import { Nav } from '@/components/nav';
import { SudoProvider } from '@/lib/sudo-client';

export const metadata: Metadata = {
  title: 'backup-mgr panel',
  description: 'Control panel for backup-mgr',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        {
}
        <SudoProvider>
          <Nav />
          <main className="mx-auto max-w-7xl px-3 py-5 sm:px-4 sm:py-6">{children}</main>
        </SudoProvider>
      </body>
    </html>
  );
}
