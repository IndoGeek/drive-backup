import './globals.css';
import type { Metadata } from 'next';
import { Nav } from '@/components/nav';

export const metadata: Metadata = {
  title: 'backup-mgr panel',
  description: 'Control panel for backup-mgr',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Nav />
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
