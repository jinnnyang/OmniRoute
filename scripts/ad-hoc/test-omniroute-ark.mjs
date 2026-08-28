// Test full chain: openai SDK -> OmniRoute proxy (/api/v1) -> Volcengine Ark.
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "omni-local", // REQUIRE_API_KEY=false so any key works
  baseURL: "http://localhost:20128/api/v1",
});

async function main() {
  const res = await client.chat.completions.create({
    model: "ark/deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply with exactly: OMNIROUTE_OK" }],
    max_tokens: 20,
  });
  console.log("OMNI->ARK CHAT OK:", JSON.stringify(res.choices[0].message.content));
  console.log("model:", res.model, "| id:", res.id);
}

main().catch((e) => {
  console.log("ERR:", e.status, e.message);
  process.exit(1);
});
