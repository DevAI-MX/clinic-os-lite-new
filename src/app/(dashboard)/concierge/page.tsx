import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ConciergePage } from '@/components/concierge/concierge-page';

export const metadata: Metadata = {
  title: 'Concierge — clinicOS',
};

// Suspense: ConciergePage lee useSearchParams (?s=<sesión>) y Next exige
// un boundary alrededor durante el prerender.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <ConciergePage />
    </Suspense>
  );
}
