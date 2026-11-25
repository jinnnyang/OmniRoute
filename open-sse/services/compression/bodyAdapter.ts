type MessageLike = {
  role?: unknown;
  content?: unknown;
  [COMPRESSION_INPUT_INDEX]?: number;
  [key: string]: unknown;
};

export const CODEX_RESPONSE_ITEM_META = Symbol("codexResponseItemMeta");

export type CodexResponseItemMeta = {
  type: string;
  eligible: boolean;
};

type CodexMessageLike = MessageLike & {
  [CODEX_RESPONSE_ITEM_META]?: CodexResponseItemMeta;
};

type ResponsesItem = {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

const RESPONSES_MESSAGE_TYPES = new Set([
  "message",
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
  "apply_patch_call_output",
]);
const COMPRESSION_INPUT_INDEX = Symbol("compressionInputIndex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRole(role: unknown, fallback: string): string {
  return typeof role === "string" && role.length > 0 ? role : fallback;
}

function toChatContent(content: unknown, fallbackOutput?: unknown): unknown {
  return content === undefined ? fallbackOutput : content;
}

function fromChatContent(nextContent: unknown, originalContent: unknown): unknown {
  if (Array.isArray(originalContent) && typeof nextContent === "string") {
    let replaced = false;
    const mapped = originalContent.map((part) => {
      if (!isRecord(part) || typeof part.text !== "string") return part;
      if (replaced) return { ...part, text: "" };
      replaced = true;
      return { ...part, text: nextContent };
    });
    return replaced ? mapped : originalContent;
  }
  return nextContent;
}

function customToolOutputToChatContent(rawOutput: unknown): unknown {
  if (typeof rawOutput !== "string") {
    if (isRecord(rawOutput) && typeof rawOutput.output === "string") return rawOutput.output;
    return rawOutput;
  }

  try {
    const parsed = JSON.parse(rawOutput) as unknown;
    if (isRecord(parsed) && typeof parsed.output === "string") return parsed.output;
  } catch {
    // Plain-text custom tool output is already in the form compression engines expect.
  }
  return rawOutput;
}

function restoreCustomToolOutput(nextContent: unknown, originalOutput: unknown): unknown {
  if (typeof originalOutput === "string") {
    try {
      const parsed = JSON.parse(originalOutput) as unknown;
      if (isRecord(parsed) && typeof parsed.output === "string") {
        return JSON.stringify({ ...parsed, output: nextContent });
      }
    } catch {
      // Preserve the original plain-text representation below.
    }
  }
  if (isRecord(originalOutput) && typeof originalOutput.output === "string") {
    return { ...originalOutput, output: nextContent };
  }
  return fromChatContent(nextContent, originalOutput);
}

function responsesToolOutputField(item: ResponsesItem): "output" | "content" {
  return item.output !== null && item.output !== undefined ? "output" : "content";
}

function responsesItemToMessage(item: ResponsesItem): CodexMessageLike | null {
  const type = typeof item.type === "string" ? item.type : "message";
  if (!RESPONSES_MESSAGE_TYPES.has(type)) return null;

  if (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "local_shell_call_output" ||
    type === "apply_patch_call_output"
  ) {
    const rawOutput = item.output ?? item.content;
    // OpenAI Responses shape (Codex): body.input holds Responses items. When
    // output is a JSON object (not a string or content array), serialise it so
    // compression engines can process the text. On restore the serialised string
    // is kept as output — the Responses API accepts string output. (#1998)
    const isObjectOutput =
      rawOutput !== null &&
      rawOutput !== undefined &&
      typeof rawOutput === "object" &&
      !Array.isArray(rawOutput);
    return {
      role: "tool",
      content:
        type === "custom_tool_call_output"
          ? customToolOutputToChatContent(rawOutput)
          : isObjectOutput
            ? JSON.stringify(rawOutput)
            : toChatContent(rawOutput),
      [CODEX_RESPONSE_ITEM_META]: { type, eligible: false },
    };
  }

  return {
    role: normalizeRole(item.role, "user"),
    content: toChatContent(item.content, item.output),
  };
}

const DEFAULT_CODEX_PROTECTED_TOOL_NAMES = new Set([
  "read",
  "glob",
  "grep",
  "write",
  "edit",
  "websearch",
  "webfetch",
  "web_search",
  "web_fetch",
]);
function markCodexResponseEligibility(
  messages: CodexMessageLike[],
  inputItems: unknown[],
  preserveToolNames: string[] = []
): void {
  const protectedNames = new Set([
    ...DEFAULT_CODEX_PROTECTED_TOOL_NAMES,
    ...preserveToolNames.map((name) => name.trim().toLowerCase()),
  ]);
  const functionCalls = new Map<string, string>();
  const skippedCallIds = new Set<string>();
  for (const raw of inputItems) {
    if (!isRecord(raw) || raw.type !== "function_call") continue;
    if (typeof raw.call_id !== "string" || raw.call_id.length === 0) continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    functionCalls.set(raw.call_id, name);
    if (
      protectedNames.has(name.trim().toLowerCase()) ||
      name === "headless_retrieval" ||
      name.endsWith("__headless_retrieval")
    ) {
      skippedCallIds.add(raw.call_id);
    }
  }

  for (const message of messages) {
    const meta = message[CODEX_RESPONSE_ITEM_META];
    if (!meta) continue;
    if (meta.type === "local_shell_call_output" || meta.type === "apply_patch_call_output") {
      meta.eligible = true;
      continue;
    }
    if (meta.type !== "function_call_output") continue;
    const rawIndex = message[COMPRESSION_INPUT_INDEX];
    const rawItem = typeof rawIndex === "number" ? inputItems[rawIndex] : null;
    const callId = isRecord(rawItem) && typeof rawItem.call_id === "string" ? rawItem.call_id : "";
    meta.eligible = callId.length > 0 && functionCalls.has(callId) && !skippedCallIds.has(callId);
  }
}

function messageToResponsesItem(message: MessageLike, originalItem: ResponsesItem): ResponsesItem {
  const type = typeof originalItem.type === "string" ? originalItem.type : "message";
  if (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "local_shell_call_output" ||
    type === "apply_patch_call_output"
  ) {
    const outputField = responsesToolOutputField(originalItem);
    const originalOutput = originalItem[outputField];
    return {
      ...originalItem,
      [outputField]:
        type === "custom_tool_call_output"
          ? restoreCustomToolOutput(message.content, originalOutput)
          : fromChatContent(message.content, originalOutput),
    };
  }

  return {
    ...originalItem,
    content: fromChatContent(message.content, originalItem.content),
  };
}

function hasTextContent(message: MessageLike): boolean {
  if (typeof message.content === "string") return message.content.length > 0;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (part) => isRecord(part) && typeof part.text === "string" && part.text.length > 0
  );
}

function isInlineBase64ImageUrl(value: unknown): boolean {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

/** Image-only Responses turns must enter the adapter so #8560 image pruning can see them. */
function hasInlineImageContent(message: MessageLike): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    if (!isRecord(part)) return false;
    if (part.type === "input_image" && isInlineBase64ImageUrl(part.image_url)) return true;
    if (part.type === "image_url") {
      const imageUrl = part.image_url;
      if (isInlineBase64ImageUrl(imageUrl)) return true;
      return isRecord(imageUrl) && isInlineBase64ImageUrl(imageUrl.url);
    }
    if (part.type === "image") {
      if (isInlineBase64ImageUrl(part.image)) return true;
      const source = part.source;
      return isRecord(source) && source.type === "base64" && typeof source.data === "string";
    }
    const inlineData = part.inlineData ?? part.inline_data;
    return isRecord(inlineData) && typeof inlineData.data === "string";
  });
}

function hasCompressibleContent(message: MessageLike): boolean {
  return hasTextContent(message) || hasInlineImageContent(message);
}

export type CompressionBodyRestoreOptions = {
  /**
   * When true, mapped `input[]` items whose synthetic messages were removed
   * (e.g. compressContext Layer-3 purifyHistory) are omitted from the restored
   * Responses payload. Default false preserves prior engine behavior: lite
   * dedup may drop a synthetic duplicate without mutating the original input
   * item positions (#8560 compaction opts in explicitly).
   */
  dropMissingMappedItems?: boolean;
};

export type CompressionBodyAdapter = {
  body: Record<string, unknown>;
  adapted: boolean;
  restore(
    compressedBody: Record<string, unknown>,
    options?: CompressionBodyRestoreOptions
  ): Record<string, unknown>;
};

export function adaptBodyForCompression(
  body: Record<string, unknown>,
  preserveToolNames: string[] = []
): CompressionBodyAdapter {
  if (Array.isArray(body.messages)) {
    return {
      body,
      adapted: false,
      restore: (compressedBody) => compressedBody,
    };
  }

  if (!Array.isArray(body.input) && typeof body.input !== "string") {
    return {
      body,
      adapted: false,
      restore: (compressedBody) => compressedBody,
    };
  }

  const inputItems = Array.isArray(body.input)
    ? body.input
    : [{ type: "message", role: "user", content: body.input }];
  const mappings: Array<{ index: number; item: ResponsesItem }> = [];
  const messages: MessageLike[] = [];

  inputItems.forEach((item, index) => {
    if (!isRecord(item)) return;
    const message = responsesItemToMessage(item);
    if (!message || !hasCompressibleContent(message)) return;
    mappings.push({ index, item: item as ResponsesItem });
    messages.push({ ...message, [COMPRESSION_INPUT_INDEX]: index });
  });

  markCodexResponseEligibility(messages, inputItems, preserveToolNames);

  if (messages.length === 0) {
    return {
      body,
      adapted: false,
      restore: (compressedBody) => compressedBody,
    };
  }

  const bodyWithoutInput = { ...body };
  delete bodyWithoutInput.input;
  const mappedIndexSet = new Set(mappings.map((mapping) => mapping.index));

  return {
    body: { ...bodyWithoutInput, messages },
    adapted: true,
    restore(compressedBody, options = {}) {
      const dropMissingMappedItems = options.dropMissingMappedItems === true;
      const compressedMessagesByIndex = new Map<number, MessageLike>();
      if (Array.isArray(compressedBody.messages)) {
        for (const message of compressedBody.messages as MessageLike[]) {
          if (typeof message[COMPRESSION_INPUT_INDEX] === "number") {
            compressedMessagesByIndex.set(message[COMPRESSION_INPUT_INDEX], message);
          }
        }
      }

      if (!dropMissingMappedItems) {
        // Legacy restore: patch survivors in place; leave missing mapped items untouched
        // so lite/caveman dedup of synthetic messages cannot desync Responses positions.
        const nextInput = [...inputItems];
        mappings.forEach((mapping) => {
          const compressedMessage = compressedMessagesByIndex.get(mapping.index);
          if (!compressedMessage) return;
          nextInput[mapping.index] = messageToResponsesItem(compressedMessage, mapping.item);
        });
        const rest = { ...compressedBody };
        delete rest.messages;
        if (typeof body.input === "string") {
          const first = nextInput[0];
          return { ...rest, input: isRecord(first) ? (first.content ?? body.input) : body.input };
        }
        return { ...rest, input: nextInput };
      }

      // Compaction restore (#8560): rebuild input so Layer-3 history drops actually shrink
      // Responses payloads. Also drop orphan regular/custom call items whose outputs vanished.
      const nextInput: unknown[] = [];
      const survivingOutputKeys = new Set<string>();
      inputItems.forEach((item, index) => {
        if (mappedIndexSet.has(index)) {
          const compressedMessage = compressedMessagesByIndex.get(index);
          if (!compressedMessage) return;
          const mapping = mappings.find((entry) => entry.index === index);
          if (!mapping) return;
          const restored = messageToResponsesItem(compressedMessage, mapping.item);
          nextInput.push(restored);
          if (
            isRecord(restored) &&
            (restored.type === "function_call_output" ||
              restored.type === "custom_tool_call_output" ||
              restored.type === "local_shell_call_output" ||
              restored.type === "apply_patch_call_output") &&
            typeof restored.call_id === "string"
          ) {
            survivingOutputKeys.add(`${restored.type}:${restored.call_id}`);
          }
          return;
        }
        nextInput.push(item);
      });

      const cleanedInput = nextInput.filter((item) => {
        if (!isRecord(item)) return true;
        const t = item.type;
        if (
          t !== "function_call" &&
          t !== "custom_tool_call" &&
          t !== "local_shell_call" &&
          t !== "apply_patch_call"
        ) {
          return true;
        }
        if (typeof item.call_id !== "string" || item.call_id.length === 0) return true;
        const hadMappedOutput = mappings.some((mapping) => {
          const original = mapping.item;
          return (
            (original.type === "function_call_output" ||
              original.type === "custom_tool_call_output" ||
              original.type === "local_shell_call_output" ||
              original.type === "apply_patch_call_output") &&
            original.call_id === item.call_id
          );
        });
        if (!hadMappedOutput) return true;
        const outputType =
          item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output";
        return survivingOutputKeys.has(`${outputType}:${item.call_id}`);
      });

      const rest = { ...compressedBody };
      delete rest.messages;
      if (typeof body.input === "string") {
        const first = cleanedInput[0];
        return { ...rest, input: isRecord(first) ? (first.content ?? body.input) : body.input };
      }
      return { ...rest, input: cleanedInput };
    },
  };
}
