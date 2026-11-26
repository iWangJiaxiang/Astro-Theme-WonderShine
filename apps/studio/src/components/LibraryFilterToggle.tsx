import { useState } from "react";
import { t } from "../i18n";
import { useSignals } from "../reactivity";
import Icon from "./Icon";

export default function LibraryFilterToggle({ language, status }: { language: string; status: string }) {
  useSignals();
  const [expanded, setExpanded] = useState(false);
  const label = t(status === "draft" ? "草稿" : status === "published" ? "已发布" : "全部状态");
  return <button type="button" className="library-filter-toggle" aria-expanded={expanded}
    onClick={() => setExpanded(!expanded)}>
    <strong>{t("筛选")}</strong>
    <span>{[language, label].filter(Boolean).join(" · ")}</span>
    <Icon name="chevron-down" size={16} />
  </button>;
}
