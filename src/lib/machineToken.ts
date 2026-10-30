import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";

declare const require: NodeRequire | undefined;

// Keep the CommonJS request as a literal `require("node-machine-id")`: webpack
// preserves the serverExternalPackages boundary only for static require calls.
// A dynamic createRequire(argv[1])(...) gets rewritten to `(void 0)(...)` in the
// standalone bundle, throws, and silently yields an empty machine ID.
function loadMachineIdModule(): { machineIdSync?: (original?: boolean) => string; default?: { machineIdSync?: (original?: boolean) => string } } {
  if (typeof require === "function") {
    return require("node-machine-id");
  }
  return createRequire(process.argv[1] || process.cwd())("node-machine-id");
}

let machineIdSync: (original?: boolean) => string;
try {
  const mod = loadMachineIdModule();
  machineIdSync = mod.machineIdSync || mod.default?.machineIdSync;
} catch {
  machineIdSync = () => "";
}

const BUILTIN_DEFAULT_SALT = "omniroute-cli-auth-v1";

function getActiveSalt(): string {
  return process.env.OMNIROUTE_CLI_SALT || BUILTIN_DEFAULT_SALT;
}

export function deriveMachineToken(rawId: string, salt: string): string {
  if (!rawId) return "";
  return createHmac("sha256", rawId).update(salt).digest("hex");
}

export function deriveLegacyCliToken(machineId: string, salt: string): string {
  if (!machineId) return "";
  return createHash("sha256")
    .update(machineId + salt)
    .digest("hex")
    .substring(0, 32);
}

let cached: string | null = null;
let cachedSalt: string | null = null;

export function getMachineTokenSync(salt?: string): string {
  const activeSalt = salt ?? getActiveSalt();
  try {
    // machineIdSync(true) returns the original unhashed hardware ID.
    const rawId = machineIdSync(true);
    if (!rawId) return "";
    if (activeSalt === cachedSalt && cached !== null) return cached;
    const token = deriveMachineToken(rawId, activeSalt);
    if (!salt) {
      cached = token;
      cachedSalt = activeSalt;
    }
    return token;
  } catch {
    return "";
  }
}

export function getLegacyCliTokenSync(salt?: string): string {
  const activeSalt = salt ?? getActiveSalt();
  try {
    const machineId = machineIdSync();
    return deriveLegacyCliToken(machineId, activeSalt);
  } catch {
    return "";
  }
}
