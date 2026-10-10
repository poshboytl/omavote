import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { extensionError, findExtension, type ExtensionKey, type OmavoteSigner } from "../lib/extension";

interface ExtensionValue {
  /** window.omavote, once the extension has injected it on this site. */
  ext: OmavoteSigner | null;
  /** The extension's key, when this site is connected. */
  key: ExtensionKey | null;
  busy: boolean;
  error: unknown;
  connect: () => Promise<ExtensionKey | null>;
  disconnect: () => Promise<void>;
}

const Ctx = createContext<ExtensionValue | null>(null);

export function ExtensionProvider({ children }: { children: ReactNode }) {
  const [ext, setExt] = useState<OmavoteSigner | null>(() => findExtension());
  const [key, setKey] = useState<ExtensionKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async (e: OmavoteSigner | null) => {
    if (!e) return;
    try {
      setKey(await e.getKey());
    } catch (x) {
      setKey(null);
      setError(extensionError(x));
    }
  }, []);

  // On non-official sites the extension injects after the user connects from its
  // toolbar popup, i.e. after this page loaded: listen for `omavote:ready` too.
  useEffect(() => {
    const onReady = () => {
      const e = findExtension();
      setExt(e);
      void refresh(e);
    };
    const onChanged = () => void refresh(findExtension());
    window.addEventListener("omavote:ready", onReady);
    window.addEventListener("omavote:changed", onChanged);
    void refresh(findExtension());
    return () => {
      window.removeEventListener("omavote:ready", onReady);
      window.removeEventListener("omavote:changed", onChanged);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!ext) return null;
    setBusy(true);
    setError(null);
    try {
      const k = await ext.connect();
      setKey(k);
      return k;
    } catch (e) {
      setError(extensionError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [ext]);

  const disconnect = useCallback(async () => {
    if (!ext) return;
    try {
      await ext.disconnect();
    } finally {
      setKey(null);
    }
  }, [ext]);

  return <Ctx.Provider value={{ ext, key, busy, error, connect, disconnect }}>{children}</Ctx.Provider>;
}

export function useExtension(): ExtensionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExtension outside ExtensionProvider");
  return v;
}
