// Stands in for the browser pool while it is off (README: Bringing the
// browsers back): healthy for Railway, 503 for every client.
import * as NodeHttp from "node:http";

const handle = (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const healthy = path === "/healthz" || path === "/health";
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify(healthy ? { ok: true, stub: true } : { error: "browsers are off" }));
};

for (const port of new Set([
  Number(process.env.PORT || 3000),
  Number(process.env.CDP_PORT || 9222),
])) {
  const server = NodeHttp.createServer(handle);
  // WebSocket clients (Playwright, CDP) get the same 503 instead of a hang.
  server.on("upgrade", (req, socket) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
    );
  });
  server.listen(port, "::", () => console.log(`browsers stub: 503 on :${port}`));
}

process.on("SIGTERM", () => process.exit(0));
