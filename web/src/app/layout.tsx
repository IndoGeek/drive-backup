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
        {/* Owns the one sudo password dialog every page shares: privileged routes
            answer 428 and the request is retried once the password is accepted. */}
        <SudoProvider>
          <Nav />
          <main className="mx-auto max-w-7xl px-3 py-5 sm:px-4 sm:py-6">{children}</main>
        </SudoProvider>
      </body>
    </html>
  );
}
