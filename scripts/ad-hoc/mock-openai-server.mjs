// Mock OpenAI-compatible server for OmniRoute integration testing.
// Listens on :8011, answers /v1/chat/completions and /v1/models with OpenAI
// wire format so the proxy round-trip (request -> forward -> translate back)
// can be validated without any real API key.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8011);

function log(payload) {
  try {
    const body = JSON.parse(payload);
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    console.log(
      `[mock] ${new Date().toISOString()} model=${body.model || "?"} ` +
        `lastRole=${last?.role || "?"} lastContent=${
          typeof last?.content === "string"
            ? JSON.stringify(last.content.slice(0, 120))
            : "(non-text)"
        }`
    );
  } catch {
    console.log(
      `[mock] ${new Date().toISOString()} non-JSON body: ${String(payload).slice(0, 200)}`
    );
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "mock-model", object: "model", owned_by: "mock" },
            { id: "mock-gpt", object: "model", owned_by: "mock" },
          ],
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      log(raw);
      const echoed = (() => {
        try {
          const body = JSON.parse(raw);
          return body?.model || "mock-model";
        } catch {
          return "mock-model";
        }
      })();
      res.end(
        JSON.stringify({
          id: "mock-chatcmpl-001",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: echoed,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `Mock reply for ${echoed}. OmniRoute proxy round-trip OK.`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `mock 404: ${req.method} ${url.pathname}` } }));
  });
});

server.listen(PORT, () => {
  console.log(`[mock] OpenAI-compatible mock listening on http://localhost:${PORT}`);
});
