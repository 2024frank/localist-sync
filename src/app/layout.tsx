import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Events Ingestion Software',
  description: 'AI Events Ingestion Software — AI-powered event ingestion and review platform',
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
