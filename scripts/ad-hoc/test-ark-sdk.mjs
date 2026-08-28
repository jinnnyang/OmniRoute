// Test the Volcengine Ark coding endpoint using the official OpenAI SDK.
import OpenAI from "openai";

const API_KEY = process.env.ARK_KEY;
const BASE = process.env.ARK_BASE || "https://ark.cn-beijing.volces.com/api/coding/v3";
const MODEL = process.env.ARK_MODEL || "deepseek-v4-flash";

if (!API_KEY) {
  console.error("ARK_KEY env var is required (never hardcode credentials).");
  process.exit(1);
}

const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE });

async function main() {
  // 1) Chat Completions
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly: ARK_OK" }],
      max_tokens: 20,
    });
    console.log("CHAT_COMPLETIONS OK:", JSON.stringify(res.choices[0].message.content));
  } catch (e) {
    console.log("CHAT_COMPLETIONS ERR:", e.status, e.message);
  }

  // 2) Responses API (endpoint advertises support)
  try {
    const resp = await client.responses.create({
      model: MODEL,
      input: "Reply with exactly: RESP_OK",
      max_output_tokens: 20,
    });
    const text = resp.output_text || resp.output_text?.length;
    console.log("RESPONSES OK:", JSON.stringify(text ?? resp.output));
  } catch (e) {
    console.log("RESPONSES ERR:", e.status, e.message);
  }
}

main();
