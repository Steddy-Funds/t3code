// Routes the steddy.dev tunnel (README: steddy.dev tunnels) to local ports:
// cloudflared sends every hostname to 127.0.0.1:8787, and the first label of
// the Host picks the port from the map that `t3-expose` writes.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
    const upstream = NodeHttp.request({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        "x-forwarded-host": req.headers.host,
        "x-forwarded-proto": "https",
      },
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode, up.rawHeaders);
      up.pipe(res);
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
    const upstream = NodeNet.connect(port, "127.0.0.1");
    let connected = false;
    upstream.on("connect", () => {
      connected = true;
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
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
  return server;
};

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.T3_ROUTER_PORT || 8787);
  createRouter().listen(port, "127.0.0.1", () =>
    console.log(`t3-router: 127.0.0.1:${port} -> ${defaultMapPath()}`),
  );
}
