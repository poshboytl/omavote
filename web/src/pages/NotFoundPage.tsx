import { Link } from "react-router";
import { useI18n } from "../app/i18n";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <h1>{t("notFound.title")}</h1>
      <p>
        <Link to="/">{t("nav.proposals")}</Link>
      </p>
    </div>
  );
}
