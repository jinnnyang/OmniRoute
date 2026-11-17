"use client";

/**
 * Catalog visibility toggles for /v1/models.
 *
 * These two settings existed only in the settings API (`hideAllProviders`,
 * `hideNoauthProviders`, added 2026-10-13) with no dashboard surface, so an operator
 * had to curl PATCH /api/settings. They are deliberately *global* — per-key
 * narrowing is `modelAccessMode=restricted` + allowedModels/allowedCombos on the key.
 *
 * Wording matters here: `hideAllProviders` only filters the catalog. Direct calls to
 * a hidden provider model still route (routing is unaffected), which is exactly what
 * operators expect when they only want to tidy the list.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Toggle from "@/shared/components/Toggle";

type VisibilityKey = "hideAllProviders" | "hideNoauthProviders";
type Status = "idle" | "saved" | "error";

export default function CatalogVisibilityCard() {
  const t = useTranslations("catalogVisibility");
  const [values, setValues] = useState<Record<VisibilityKey, boolean>>({
    hideAllProviders: false,
    hideNoauthProviders: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<VisibilityKey | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const settings = data.settings ?? data;
        setValues({
          hideAllProviders: settings.hideAllProviders === true,
          hideNoauthProviders: settings.hideNoauthProviders === true,
        });
      })
      .catch(() => {
        /* fail-open: leave the toggles at their read state */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(
    async (key: VisibilityKey, next: boolean) => {
      if (saving) return;
      const previous = values;
      setValues({ ...values, [key]: next });
      setSaving(key);
      setStatus("idle");
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: next }),
        });
        if (!res.ok) throw new Error(`PATCH /api/settings ${res.status}`);
        setStatus("saved");
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 2000);
      } catch {
        setValues(previous);
        setStatus("error");
      } finally {
        setSaving(null);
      }
    },
    [saving, values]
  );

  if (loading) return null;

  return (
    <section
      className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      aria-labelledby="catalog-visibility-title"
    >
      <div className="mb-3">
        <h2 id="catalog-visibility-title" className="text-sm font-semibold">
          {t("title")}
        </h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("description")}</p>
      </div>
      <div className="space-y-3">
        <Toggle
          label={t("hideAllProviders")}
          description={t("hideAllProvidersDescription")}
          checked={values.hideAllProviders}
          onChange={(next) => update("hideAllProviders", next)}
          disabled={saving !== null}
        />
        <Toggle
          label={t("hideNoauthProviders")}
          description={t("hideNoauthProvidersDescription")}
          checked={values.hideNoauthProviders}
          onChange={(next) => update("hideNoauthProviders", next)}
          disabled={saving !== null}
        />
      </div>
      {status === "saved" && (
        <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{t("saved")}</p>
      )}
      {status === "error" && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{t("error")}</p>
      )}
    </section>
  );
}
