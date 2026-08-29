// Bytez key validator — auth-only probe against the model-independent tasks
// endpoint. Extracted from the former webCookie.ts when web-cookie providers
// were removed (trim-core B): Bytez is an API-key provider and its validator
// must survive the web-cookie machinery deletion.
import { validationRead } from "./transport";
import { buildBearerHeaders } from "./headers";
import { toValidationErrorResult } from "./transport";

// #5422: Bytez key validation cannot use a chat probe. A Bytez account only serves models
// that have been added to its catalog, so even Bytez's own documented model ids return 404
// ("Model does not exist or has yet to be added to the Bytez catalog") for a fresh/free key —
// the generic OpenAI-like chat probe misreads that 404 as "endpoint not supported". Validate
// against the model-independent, auth-only tasks endpoint instead (verified live):
//   GET …/models/v2/list/tasks → 200 (valid key) | 401 { error: "Unauthorized" } (invalid).
// The pure status→result mapping is factored out so it is unit-testable without network.
export function bytezValidationResultFromStatus(status: number): {
  valid: boolean;
  error: string | null;
} {
  if (status === 200) {
    return { valid: true, error: null };
  }
  if (status === 401 || status === 403) {
    return { valid: false, error: "Invalid API key" };
  }
  return { valid: false, error: `Validation failed: ${status}` };
}

export async function validateBytezProvider({ apiKey, providerSpecificData = {} }: any) {
  try {
    const res = await validationRead("https://api.bytez.com/models/v2/list/tasks", {
      method: "GET",
      headers: buildBearerHeaders(apiKey, providerSpecificData),
    });
    return bytezValidationResultFromStatus(res.status);
  } catch (error: unknown) {
    return toValidationErrorResult(error);
  }
}
