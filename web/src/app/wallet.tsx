import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  discoverProviders,
  preferredProvider,
  requestAccounts,
  WalletError,
  type DiscoveredProvider,
  type Eip1193Provider,
} from "../lib/eip1193";

interface WalletValue {
  providers: DiscoveredProvider[] | null;
  selected: DiscoveredProvider | null;
  select: (uuid: string) => void;
  address: string | null;
  provider: Eip1193Provider | null;
  busy: boolean;
  error: unknown;
  connect: () => Promise<string | null>;
  disconnect: () => void;
}

const Ctx = createContext<WalletValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<DiscoveredProvider[] | null>(null);
  const [selected, setSelected] = useState<DiscoveredProvider | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const discover = useCallback(async () => {
    const list = await discoverProviders();
    setProviders(list);
    const pref = preferredProvider(list);
    setSelected((cur) => (cur && list.some((p) => p.info.uuid === cur.info.uuid) ? cur : pref));
    return { list, pref };
  }, []);

  useEffect(() => {
    void discover();
  }, [discover]);

  // Follow account switches in the wallet: the connected key changes what we may sign.
  useEffect(() => {
    const p = selected?.provider;
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0];
      if (Array.isArray(accounts) && typeof accounts[0] === "string") setAddress(accounts[0]);
      else setAddress(null);
    };
    p.on("accountsChanged", onAccounts);
    return () => p.removeListener?.("accountsChanged", onAccounts);
  }, [selected]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let target = selected;
      if (!target) target = (await discover()).pref;
      if (!target) throw new WalletError("no_wallet", "no EIP-1193 wallet found");
      const accounts = await requestAccounts(target.provider);
      const a = accounts[0] ?? null;
      setAddress(a);
      return a;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }, [selected, discover]);

  const value: WalletValue = {
    providers,
    selected,
    select: (uuid) => {
      const p = providers?.find((x) => x.info.uuid === uuid) ?? null;
      setSelected(p);
      setAddress(null);
    },
    address,
    provider: selected?.provider ?? null,
    busy,
    error,
    connect,
    disconnect: () => setAddress(null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
