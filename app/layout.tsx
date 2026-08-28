import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { siteUrl } from './seo';
import { createSportsTeamStructuredData, createWebSiteStructuredData, serializeStructuredData, stableSportsTeamId } from '../src/lib/structured-data';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin']
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin']
});

export const metadata: Metadata = {
  title: 'Rhule Aid | Nebraska Football',
  description: 'A modern Nebraska Cornhuskers football hub for schedules, game day, roster, news, and more.',
  metadataBase: new URL(siteUrl),
  alternates: { canonical: siteUrl },
  icons: { icon: '/images/favicon-rhuleaid.png' },
  openGraph: {
    type: 'website',
    siteName: 'Rhule Aid',
    title: 'Rhule Aid | Nebraska Football',
    description: 'Nebraska football schedules, game day, roster, and news.'
  },
  twitter: {
    card: 'summary',
    title: 'Rhule Aid | Nebraska Football',
    description: 'Nebraska football schedules, game day, roster, and news.'
  }
};

const sportsTeamStructuredData = createSportsTeamStructuredData({
  name: 'Nebraska Cornhuskers',
  url: siteUrl,
  id: stableSportsTeamId('nebraska-cornhuskers', siteUrl),
  logo: `${siteUrl}/images/logos/nebraska-logo.png`,
  sameAs: ['https://huskers.com/sports/football']
});

const websiteStructuredData = createWebSiteStructuredData(siteUrl, 'Rhule Aid');

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {websiteStructuredData && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: serializeStructuredData(websiteStructuredData) }}
          />
        )}
        {sportsTeamStructuredData && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: serializeStructuredData(sportsTeamStructuredData) }}
          />
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}`
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <div className="grain-overlay" />
        {children}
      </body>
    </html>
  );
}
