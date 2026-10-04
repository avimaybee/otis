import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../src/api/queries.js';

/** Fresh scoped query client per mount so tests never share server snapshots. */
export function TestQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createAppQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
