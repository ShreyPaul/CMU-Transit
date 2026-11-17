/*
 * Polls TransitFeed.refreshLive and exposes the latest vehicle snapshot plus a server clock offset.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchLiveSnapshot } from '@/api/transit';
import { LiveSnapshot } from '@/Interfaces';

/** Client poll cadence. The server only pulls upstream every `TransitConfig.vehicleRefreshSeconds`. */
const POLL_MS = 15000;

export interface LiveVehiclesState {
  snapshot: LiveSnapshot | null;
  /** Server time minus client time, in ms, so ages are computed on the server clock. */
  clockOffsetMs: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLiveVehicles(): LiveVehiclesState {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const forceNext = useRef(false);

  const refresh = useCallback(() => {
    forceNext.current = true;
    setLoading(true);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      if (document.hidden) {
        timer = setTimeout(load, POLL_MS);
        return;
      }
      const force = forceNext.current;
      forceNext.current = false;
      try {
        const sentAt = Date.now();
        const snap = await fetchLiveSnapshot(force);
        if (cancelled) return;
        const receivedAt = Date.now();
        setClockOffsetMs(new Date(snap.serverTime).getTime() - (sentAt + receivedAt) / 2);
        setSnapshot(snap);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, POLL_MS);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  return { snapshot, clockOffsetMs, loading, error, refresh };
}

/** Re-renders every `intervalMs` so relative times ("12s ago") stay current. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
