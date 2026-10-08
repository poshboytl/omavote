import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { Notice } from "../components/ui";
import { assessSync } from "../lib/flow";
import { useI18n } from "./i18n";
import { useApp } from "./state";

const NAV = [
  ["/", "nav.proposals"],
  ["/address", "nav.address"],
  ["/create", "nav.create"],
  ["/records", "nav.records"],
  ["/receipt", "nav.receipts"],
  ["/verify", "nav.verify"],
  ["/status", "nav.status"],
  ["/wallet-check", "nav.walletCheck"],
] as const;

/** Shadow mode until governance approves the deployment (`governance_confirmed`). */
function ShadowBanner() {
  const { t } = useI18n();
  const { status } = useApp();
  if (!status?.shadow_mode) return null;
  return (
    <Notice tone="info" title={t("banner.shadowTitle")}>
      {t("banner.shadowText")}
    </Notice>
  );
}

function StatusBanner() {
  const { t, tk } = useI18n();
  const { status, statusError, statusFetchedAt, apiBase } = useApp();
  if (statusError) {
    return (
      <Notice tone="bad" title={t("banner.unreachable")}>
        {statusError} · {t("banner.apiBase", { base: apiBase || t("settings.sameOrigin") })}{" "}
        <Link to="/settings">{t("nav.settings")}</Link>
      </Notice>
    );
  }
  if (!status) return null;
  const a = assessSync(status, statusFetchedAt || Date.now());
  if (a.ok) return null;
  return (
    <Notice tone="warn" title={t("banner.behind")}>
      {a.issues.map((i) => tk(i.key, i as unknown as Record<string, string>)).join(" · ")}{" "}
      <Link to="/status">{t("nav.status")}</Link>
    </Notice>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { status, apiBase, core } = useApp();
  return (
    <div className="app">
      <header className="top">
        <div className="top-inner">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◆
            </span>
            <span className="brand-name">Omavote</span>
            <span className="brand-sub">{t("brand.sub")}</span>
          </Link>
          <div className="top-tools">
            {status && (
              <span className={`net-pill ${status.network.name === "mainnet" ? "net-main" : "net-test"}`} title={status.network.genesis_hash}>
                {status.network.name}
              </span>
            )}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
              aria-label={t("lang.switch")}
            >
              {lang === "zh" ? "English" : "中文"}
            </button>
          </div>
        </div>
        <nav className="nav" aria-label={t("nav.label")}>
          {NAV.map(([to, key]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : undefined)}>
              {t(key)}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="banner-wrap">
        <ShadowBanner />
        <StatusBanner />
      </div>
      <main className="main">{children}</main>
      <footer className="foot">
        <p>{t("footer.keys")}</p>
        <p>{t("footer.cache")}</p>
        <p className="muted small">
          {t("footer.api", { base: apiBase || t("settings.sameOrigin") })} · <Link to="/settings">{t("nav.settings")}</Link>
          {core && ` · core ${core.version}`}
          {status && ` · server ${status.version}`}
        </p>
      </footer>
    </div>
  );
}
