import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSummary } from "../lib/client";
import type { Summary } from "../lib/client";
import type { PairedServer } from "../lib/vault";
import { describeError } from "../lib/pairing";

const POLL_MS = 10_000;

export type SummaryState = {
  data: Summary | null;
  error: string | null;
  /** True only for the very first load, so a refresh doesn't blank the screen. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  /** When the currently displayed data was actually fetched. */
  fetchedAt: number | null;
};

/**
 * Poll a machine's summary while the app is in the foreground.
 *
 * Polling pauses when the tab is hidden and resumes with an immediate fetch on
 * return — a phone spends most of its life with the screen off, and a timer
 * that keeps firing there costs battery to produce data nobody reads. Coming
 * back to stale numbers is the worse failure, hence the immediate refetch.
 */
export function useSummary(server: PairedServer | null): SummaryState {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(server));
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const serverId = server?.id ?? null;

  const load = useCallback(
    async (isBackground: boolean) => {
      if (!server) return;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      if (!isBackground) setRefreshing(true);
      try {
        const next = await fetchSummary(server, controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
        setFetchedAt(Date.now());
      } catch (err) {
        if (controller.signal.aborted) return;
        // Keep the last good data on screen: stale numbers with an explicit
        // "can't reach" banner beat an empty screen on a flaky connection.
        setError(describeError(err));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [server]
  );

  useEffect(() => {
    if (!serverId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setData(null);
    void load(true);

    let timer: ReturnType<typeof setInterval> | null = null;
    const startPolling = (): void => {
      if (timer) return;
      timer = setInterval(() => void load(true), POLL_MS);
    };
    const stopPolling = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void load(true);
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
      inFlight.current?.abort();
    };
  }, [serverId, load]);

  return {
    data,
    error,
    loading,
    refreshing,
    refresh: () => void load(false),
    fetchedAt
  };
}
