// Routes the steddy.dev tunnel (README: steddy.dev tunnels) to local ports:
// cloudflared sends every hostname to 127.0.0.1:8787, and the first label of
// the Host picks the port from the map that `t3-expose` writes.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";

export const defaultMapPath = () =>
  NodePath.join(
    process.env.T3_EXPOSE_DIR || NodePath.join(NodeOS.homedir(), ".t3-expose"),
    "map.json",
  );

// Read on every request, so `t3-expose` takes effect without a restart.
const lookup = (mapPath, host) => {
  const name = String(host || "")
    .replace(/:\d+$/, "")
    .split(".")[0]
    .toLowerCase();
  let map = {};
  try {
    map = JSON.parse(NodeFS.readFileSync(mapPath, "utf8"));
  } catch {}
  const port = Number(map[name]);
  return { name, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined };
};

const LOOP = "x-t3-router";

// Access credentials stay at the edge: an exposed app is agent code, and the
// same JWT opens every other host behind the Access application.
const forwardHeaders = (req) => {
  const headers = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    let value = req.rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (["cf-access-jwt-assertion", "x-forwarded-host", "x-forwarded-proto"].includes(lower))
      continue;
    if (lower === "cookie") {
      value = value
        .split(";")
        .filter((c) => !/^\s*CF_Authorization=/i.test(c))
        .join(";")
        .trim();
      if (!value) continue;
    }
    headers.push([name, value]);
  }
  headers.push(
    ["X-Forwarded-Host", req.headers.host ?? ""],
    ["X-Forwarded-Proto", "https"],
    [LOOP, "1"],
  );
  return headers;
};

const loopError = (name) => ({ error: `${name} is mapped to the tunnel router itself` });

const json = (status, body) => {
  const text = JSON.stringify(body);
  return `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`;
};

export const createRouter = ({ mapPath = defaultMapPath() } = {}) => {
  const server = NodeHttp.createServer((req, res) => {
    const { name, port } = lookup(mapPath, req.headers.host);
    const reply = (status, body) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(body));
    };
    if (!port) return reply(404, { error: `nothing is exposed on ${name || "this name"}` });
    if (req.headers[LOOP]) return reply(508, loopError(name));
    const upstream = NodeHttp.request({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req).flat(),
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode, up.rawHeaders);
      // Destroys res when the app dies mid-body, so the client sees a reset, not a hang.
      NodeStream.pipeline(up, res, () => {});
    });
    upstream.on("error", (err) =>
      reply(502, { error: `${name}: port ${port} is not answering (${err.code || err.message})` }),
    );
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("upgrade", (req, client, head) => {
    const { name, port } = lookup(mapPath, req.headers.host);
    client.on("error", () => {});
    if (!port)
      return client.end(json(404, { error: `nothing is exposed on ${name || "this name"}` }));
    if (req.headers[LOOP]) return client.end(json(508, loopError(name)));
    const upstream = NodeNet.connect(port, "127.0.0.1");
    let connected = false;
    upstream.on("connect", () => {
      connected = true;
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of forwardHeaders(req)) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.on("error", (err) => {
      if (!connected)
        client.end(
          json(502, {
            error: `${name}: port ${port} is not answering (${err.code || err.message})`,
          }),
        );
      else client.destroy();
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  // cloudflared keeps idle origin connections for 90 s; closing them sooner
  // turns a reused connection into an edge 502.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  return server;
};

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.T3_ROUTER_PORT || 8787);
  createRouter().listen(port, "127.0.0.1", () =>
    console.log(`t3-router: 127.0.0.1:${port} -> ${defaultMapPath()}`),
  );
}
