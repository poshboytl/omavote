import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, normalizeApiBase } from "../lib/api";
import type { Core } from "../lib/core";
import { KEYS, readString, writeString } from "../lib/storage";
import type { NetworkInfo, StatusView } from "../lib/types";
import { loadCore } from "../wasm/load";

interface AppValue {
  apiBase: string;
  setApiBase: (base: string) => boolean;
  api: Api;
  core: Core | null;
  coreError: string | null;
  network: NetworkInfo | null;
  networkError: string | null;
  reloadNetwork: () => void;
  status: StatusView | null;
  statusError: string | null;
  /** Local wall-clock time (ms) at which `status` was fetched. */
  statusFetchedAt: number;
  refreshStatus: () => Promise<StatusView | null>;
}

const Ctx = createContext<AppValue | null>(null);

const STATUS_INTERVAL_MS = 15_000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [apiBase, setBase] = useState(() => normalizeApiBase(readString(KEYS.apiBase, "")) ?? "");
  const api = useMemo(() => new Api(apiBase), [apiBase]);
  const [core, setCore] = useState<Core | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [networkTick, setNetworkTick] = useState(0);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusFetchedAt, setStatusFetchedAt] = useState(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    loadCore().then(setCore, (e: unknown) => setCoreError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    let live = true;
    setNetwork(null);
    setNetworkError(null);
    api.network().then(
      (n) => live && setNetwork(n),
      (e: unknown) => live && setNetworkError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, networkTick]);

  const refreshStatus = useCallback(async () => {
    const a = apiRef.current;
    try {
      const s = await a.status();
      if (apiRef.current === a) {
        setStatus(s);
        setStatusError(null);
        setStatusFetchedAt(Date.now());
      }
      return s;
    } catch (e) {
      if (apiRef.current === a) setStatusError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    void refreshStatus();
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refreshStatus();
    }, STATUS_INTERVAL_MS);
    return () => clearInterval(id);
  }, [api, refreshStatus]);

  const setApiBase = useCallback((input: string) => {
    const n = normalizeApiBase(input);
    if (n === null) return false;
    writeString(KEYS.apiBase, n === "" ? null : n);
    setBase(n);
    return true;
  }, []);

  const value: AppValue = {
    apiBase,
    setApiBase,
    api,
    core,
    coreError,
    network,
    networkError,
    reloadNetwork: () => setNetworkTick((x) => x + 1),
    status,
    statusError,
    statusFetchedAt,
    refreshStatus,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Async loader with stale-response protection. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}
