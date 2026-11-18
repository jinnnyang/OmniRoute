"use client";

/**
 * Catalog visibility settings for /v1/models.
 *
 * `hideAllProviders` and `hideNoauthProviders` shipped in the settings API (2026-10-13)
 * with no dashboard surface, so flipping them meant curling PATCH /api/settings. They are
 * *settings*, not feature flags — there is no env override and no DB-vs-env precedence
 * badge — but they belong on this page, so the cards borrow the flag card chrome
 * (rounded-xl, soft shadow, emerald border when on, mono key, source badge, reset).
 *
 * Wording matters: `hideAllProviders` only filters the catalog. Direct calls to a hidden
 * provider model still route, which is what an operator wants when they only mean to tidy
 * the list. Per-key narrowing stays `modelAccessMode=restricted` + allowed models/combos.
 *
 * `hideAutoCombos` (2026-11-18) had the same gap: it shipped in the settings API as the
 * only way to keep the 40-odd built-in `auto/*` virtual combos out of `/v1/models`, with
 * no dashboard surface at all. Same wording caveat — it unadvertises ids that still route
 * when sent explicitly; use `autoRoutingEnabled` when the ids must be rejected outright.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type VisibilityKey = "hideAllProviders" | "hideNoauthProviders" | "hideAutoCombos";
type Status = "idle" | "saved" | "error";

const CARDS: VisibilityKey[] = ["hideAllProviders", "hideNoauthProviders", "hideAutoCombos"];

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-text-primary"
      aria-hidden="true"
    />
  );
}

export default function CatalogVisibilityCards() {
  const t = useTranslations("catalogVisibility");
  const tFlags = useTranslations("featureFlags");
  const tSettings = useTranslations("settings");

  const [values, setValues] = useState<Record<VisibilityKey, boolean>>({
    hideAllProviders: false,
    hideNoauthProviders: false,
    hideAutoCombos: false,
  });
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<VisibilityKey | null>(null);
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
          hideAutoCombos: settings.hideAutoCombos === true,
        });
      })
      .catch(() => {
        /* leave the toggles at their read state */
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
      if (savingKey) return;
      const previous = values;
      setValues({ ...values, [key]: next });
      setSavingKey(key);
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
        setSavingKey(null);
      }
    },
    [savingKey, values]
  );

  // Literal keys only: the repo enables next-intl's typed messages, and a computed
  // key would widen t()'s argument to `string`.
  const text: Record<VisibilityKey, { label: string; description: string }> = {
    hideAllProviders: {
      label: t("hideAllProviders"),
      description: t("hideAllProvidersDescription"),
    },
    hideNoauthProviders: {
      label: t("hideNoauthProviders"),
      description: t("hideNoauthProvidersDescription"),
    },
    hideAutoCombos: {
      label: t("hideAutoCombos"),
      description: t("hideAutoCombosDescription"),
    },
  };

  if (loading) return null;

  return (
    <section className="space-y-3" aria-labelledby="catalog-visibility-heading">
      <div>
        <h2 id="catalog-visibility-heading" className="text-sm font-semibold text-text-primary">
          {t("title")}
        </h2>
        <p className="mt-1 text-xs text-text-muted">{t("description")}</p>
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}
      >
        {CARDS.map((key) => {
          const on = values[key];
          const saving = savingKey === key;
          return (
            <div
              key={key}
              role="group"
              aria-label={text[key].label}
              className={`rounded-xl border bg-card p-4 shadow-soft transition-all duration-200 hover:-translate-y-px hover:border-black/15 hover:bg-bg-subtle/60 hover:shadow-elevated dark:hover:border-white/15 dark:hover:bg-surface ${
                on
                  ? "border-emerald-300 shadow-emerald-500/10 dark:border-green-500/30"
                  : "border-border"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="flex-1 truncate font-mono text-xs font-semibold text-text-primary">
                  {key}
                </span>
                <div className="flex items-center gap-2">
                  {saving && <Spinner />}
                  <button
                    role="switch"
                    aria-checked={on}
                    aria-label={text[key].label}
                    disabled={saving}
                    onClick={() => update(key, !on)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${
                      on ? "bg-emerald-500" : "bg-slate-300 dark:bg-white/20"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                        on ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Not clamped like the flag descriptions: "direct calls still route" is
                  the one line an operator must not miss. */}
              <p className="mb-3 text-xs text-text-muted">{text[key].description}</p>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-text-muted">{tFlags("source")}:</span>
                  <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-xs font-medium text-emerald-700 dark:border-green-500/20 dark:bg-green-500/15 dark:text-green-300">
                    DB
                  </span>
                </div>

                {on && (
                  <button
                    aria-label={tFlags("resetFlag", { label: text[key].label })}
                    disabled={saving}
                    onClick={() => update(key, false)}
                    className="inline-flex items-center gap-1 rounded text-xs text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      refresh
                    </span>
                    {tFlags("reset")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="h-4 text-xs" aria-live="polite">
        {status === "saved" && (
          <span className="text-emerald-600 dark:text-emerald-400">{tSettings("saved")}</span>
        )}
        {status === "error" && (
          <span className="text-red-600 dark:text-red-400">{tSettings("saveFailed")}</span>
        )}
      </p>
    </section>
  );
}
