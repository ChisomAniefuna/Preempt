'use client';
import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

/** Calls `onChange` whenever one of the tables changes. Realtime is a nudge; the caller refetches under RLS. */
export function useRealtime(channel: string, tables: string[], onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const sb = createClient();
    let ch = sb.channel(channel);
    for (const table of tables) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb.current());
    ch.subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, tables.join(',')]);
}
