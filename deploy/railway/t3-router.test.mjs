import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { createRouter } from "./t3-router.mjs";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const setup = async (t) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-router-"));
  const mapPath = NodePath.join(dir, "map.json");
  const router = createRouter({ mapPath });
  const port = await listen(router);
  t.after(() => {
    router.closeAllConnections();
    router.close();
    NodeFS.rmSync(dir, { recursive: true });
  });
  const expose = (map) => NodeFS.writeFileSync(mapPath, JSON.stringify(map));
  return { port, expose };
};

const backend = async (t, handler) => {
  const server = NodeHttp.createServer(handler);
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, port };
};

const request = (port, host, { method = "GET", body } = {}) =>
  new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      { port, host: "127.0.0.1", method, path: "/p?q=1", headers: { host } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

NodeTest.test(
  "dispatches by the Host's first label, ignoring the zone and port, and re-reads the map",
  async (t) => {
    const { port, expose } = await setup(t);
    const a = await backend(t, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () =>
        res.end(
          JSON.stringify({
            app: "a",
            method: req.method,
            url: req.url,
            host: req.headers.host,
            fwd: req.headers["x-forwarded-host"],
            body,
          }),
        ),
      );
    });
    const b = await backend(t, (_req, res) => res.end("b"));
    expose({ "t3-1": a.port, "t3-2": b.port });

    const one = await request(port, "T3-1.steddy.dev:443", { method: "POST", body: "payload" });
    NodeAssert.equal(one.status, 200);
    NodeAssert.deepEqual(JSON.parse(one.text), {
      app: "a",
      method: "POST",
      url: "/p?q=1",
      host: "T3-1.steddy.dev:443",
      fwd: "T3-1.steddy.dev:443",
      body: "payload",
    });
    NodeAssert.equal((await request(port, "t3-2.steddy.dev")).text, "b");

    expose({ "t3-1": b.port });
    NodeAssert.equal((await request(port, "t3-1.steddy.dev")).text, "b");
  },
);

NodeTest.test("404 for an unmapped name, 502 when the mapped port is down", async (t) => {
  const { port, expose } = await setup(t);
  const down = NodeNet.createServer();
  const downPort = await listen(down);
  down.close();
  expose({ "t3-1": downPort });

  const missing = await request(port, "t3-3.steddy.dev");
  NodeAssert.equal(missing.status, 404);
  NodeAssert.match(JSON.parse(missing.text).error, /t3-3/);

  const refused = await request(port, "t3-1.steddy.dev");
  NodeAssert.equal(refused.status, 502);
  NodeAssert.match(JSON.parse(refused.text).error, /port \d+ is not answering/);
});

const upgrade = (port, host) =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1", () =>
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello`,
      ),
    );
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => {
      data += c;
      if (data.includes("echo:hello") || data.includes("\r\n\r\n{")) {
        socket.end();
        resolve(data);
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });

NodeTest.test("WebSocket upgrades pass through both ways, 404 and 502 as JSON", async (t) => {
  const { port, expose } = await setup(t);
  const ws = await backend(t, (_req, res) => res.end());
  ws.server.on("upgrade", (req, socket, head) => {
    // Upgraded sockets are outside closeAllConnections.
    t.after(() => socket.destroy());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ${req.url}\r\n\r\n`,
    );
    const echo = (c) => socket.write(`echo:${c}`);
    if (head.length) echo(head);
    socket.on("data", echo);
  });
  const down = NodeNet.createServer();
  const downPort = await listen(down);
  down.close();
  expose({ "t3-1": ws.port, "t3-2": downPort });

  const ok = await upgrade(port, "t3-1.steddy.dev");
  NodeAssert.match(ok, /^HTTP\/1\.1 101 /);
  NodeAssert.match(ok, /X-Path: \/ws/);
  NodeAssert.match(ok, /echo:hello/);

  NodeAssert.match(
    await upgrade(port, "t3-5.steddy.dev"),
    /^HTTP\/1\.1 404 [\s\S]*nothing is exposed on t3-5/,
  );
  NodeAssert.match(await upgrade(port, "t3-2.steddy.dev"), /^HTTP\/1\.1 502 [\s\S]*not answering/);
});
