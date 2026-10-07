import type { ReactNode } from "react";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import type { Core } from "../lib/core";
import type { NetworkInfo } from "../lib/types";
import { Loading, Notice } from "./ui";

/** Renders children once the WASM core and the server's network parameters are loaded. */
export function NeedCore({ children }: { children: (core: Core, network: NetworkInfo) => ReactNode }) {
  const { t } = useI18n();
  const { core, coreError, network, networkError, reloadNetwork } = useApp();
  if (coreError) return <Notice tone="bad" title={t("core.failed")}>{coreError}</Notice>;
  if (networkError)
    return (
      <Notice tone="bad" title={t("network.failed")}>
        {networkError}{" "}
        <button type="button" className="btn btn-small" onClick={reloadNetwork}>
          {t("common.retry")}
        </button>
      </Notice>
    );
  if (!core) return <Loading label={t("core.loading")} />;
  if (!network) return <Loading label={t("network.loading")} />;
  return <>{children(core, network)}</>;
}
