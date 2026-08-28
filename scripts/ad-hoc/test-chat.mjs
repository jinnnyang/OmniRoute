// Send a chat request through OmniRoute's main endpoint to validate the proxy
// round-trip to the mock-local provider node. Avoids cmd/powershell quoting hell.
const BASE = "http://localhost:20128";
const MODEL = process.env.TEST_MODEL || "mocklocal/mock-model";
const MSG = process.env.TEST_MSG || "Hello! Test the OmniRoute proxy round-trip please.";

async function main() {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: MSG }],
    max_tokens: 50,
  };
  const res = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("STATUS", res.status);
  const text = await res.text();
  console.log(text.slice(0, 2500));
  try {
    const j = JSON.parse(text);
    if (j.choices?.[0]?.message?.content) {
      console.log("\nREPLY:", j.choices[0].message.content);
    }
  } catch {
    /* not json */
  }
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exit(1);
});
