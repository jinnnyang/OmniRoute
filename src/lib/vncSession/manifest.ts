import type { WebSessionCredentialRequirement } from "@/shared/providers/webSessionCredentials";

export interface VncProviderEntry {
  /** Provider id stored in provider_connections.provider. */
  id: string;
  /** Dashboard/catalog label. */
  name: string;
  /** Login page opened by the browser container. */
  url: string;
  /** Canonical OmniRoute credential contract for this provider. */
  requirement: Exclude<WebSessionCredentialRequirement, { kind: "none" }>;
}

/**
 * Providers whose credentials cannot yet be reconstructed safely from cookies,
 * localStorage/sessionStorage, and declared credential keys alone.
 */
export const VNC_UNSUPPORTED_PROVIDER_REASONS: Readonly<Record<string, string>> = {
  "copilot-m365-web":
    "requires the account-specific Chathub WebSocket path in addition to an access token",
  "inner-ai": "requires the account email in addition to the session token",
};

export function getVncProvider(_id: string | null | undefined): VncProviderEntry | null {
  // Web-cookie providers were removed (trim-core B) — the VNC browser-session
  // viewer has no catalogued providers left to serve.
  return null;
}

export function listVncProviders(): VncProviderEntry[] {
  return [];
}

export function isVncProvider(id: string | null | undefined): boolean {
  return getVncProvider(id) !== null;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const profileRoot =
  process.env.OMNIROUTE_VNC_PROFILE_DIR ||
  `${process.env.HOME || "/tmp"}/.omniroute/browser-login-profiles`;

export const VNC_CONFIG = {
  /**
   * This feature uses Chromium CDP only. Build docker/vnc-browser/chromium and
   * tag it with this name, or override OMNIROUTE_VNC_IMAGE.
   */
  image: process.env.OMNIROUTE_VNC_IMAGE || "omniroute-vnc-chromium:local",
  containerVncPort: Number(process.env.OMNIROUTE_VNC_CONTAINER_VNC_PORT || 3000),
  containerCdpPort: Number(process.env.OMNIROUTE_VNC_CONTAINER_CDP_PORT || 9223),
  containerProfileDir: process.env.OMNIROUTE_VNC_CONTAINER_PROFILE_DIR || "/config",
  profileDir: profileRoot,
  persistProfiles: envFlag("OMNIROUTE_VNC_PERSIST_PROFILES", false),
  idleTimeoutMs: Number(process.env.OMNIROUTE_VNC_IDLE_MS || 10 * 60 * 1000),
  maxSessionMs: Number(process.env.OMNIROUTE_VNC_MAX_MS || 30 * 60 * 1000),
  maxSessions: Number(process.env.OMNIROUTE_VNC_MAX_SESSIONS || 4),
  dockerBin: process.env.OMNIROUTE_DOCKER_BIN || "docker",
  browserReadyTimeoutMs: Number(process.env.OMNIROUTE_VNC_READY_MS || 45_000),
  harvestTimeoutMs: Number(process.env.OMNIROUTE_VNC_HARVEST_MS || 20_000),
  chromiumArgs:
    process.env.OMNIROUTE_VNC_CHROMIUM_ARGS ||
    "--remote-debugging-port=9222 --no-first-run --no-default-browser-check",
} as const;

export const VNC_ROUTE_PREFIX = "/api/vnc-session";
