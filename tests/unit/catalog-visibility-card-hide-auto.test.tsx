// @vitest-environment jsdom
/**
 * #10831 follow-up — the catalog visibility card must expose `hideAutoCombos`.
 *
 * `hideAutoCombos` shipped in the settings API with no dashboard surface, so the only
 * way to keep the built-in `auto/*` virtual combos out of `/v1/models` was to curl
 * PATCH /api/settings. This guards that the card renders one switch per visibility key
 * and that flipping the auto combos switch PATCHes the right key.
 */
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const CatalogVisibilityCards = (
  await import("@/app/(dashboard)/dashboard/settings/components/CatalogVisibilityCard")
).default;

type FetchCall = { url: string; method: string; body: unknown };

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

const cleanupCallbacks: Array<() => void> = [];

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => {
    container.remove();
  });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CatalogVisibilityCard", { timeout: 60_000 }, () => {
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "GET") {
        return jsonResponse({
          hideAllProviders: false,
          hideNoauthProviders: false,
          hideAutoCombos: true,
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    while (cleanupCallbacks.length > 0) {
      cleanupCallbacks.pop()?.();
    }
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders a switch for every visibility key, including hideAutoCombos", async () => {
    const container = makeContainer();
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(CatalogVisibilityCards));
    });
    await flush();

    const switches = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')
    );
    expect(switches.map((s) => s.getAttribute("aria-label"))).toEqual([
      "hideAllProviders",
      "hideNoauthProviders",
      "hideAutoCombos",
    ]);

    // The card reflects the persisted value, so an operator can see the state it is in.
    const autoSwitch = switches.find((s) => s.getAttribute("aria-label") === "hideAutoCombos");
    expect(autoSwitch?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      root.unmount();
    });
  });

  it("PATCHes hideAutoCombos when its switch is toggled", async () => {
    const container = makeContainer();
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(CatalogVisibilityCards));
    });
    await flush();

    const autoSwitch = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')
    ).find((s) => s.getAttribute("aria-label") === "hideAutoCombos");
    expect(autoSwitch).toBeTruthy();

    await act(async () => {
      autoSwitch!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe("/api/settings");
    expect(patches[0].body).toEqual({ hideAutoCombos: false });

    await act(async () => {
      root.unmount();
    });
  });
});
