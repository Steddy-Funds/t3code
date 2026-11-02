// `t3-expose <name> <port>`, `t3-expose --list` and `t3-unexpose <name>`
// (README: steddy.dev tunnels). Edits the map t3-router.mjs reads.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { defaultMapPath } from "./t3-router.mjs";

const names = (process.env.T3_TUNNEL_NAMES || "")
  .split(",")
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);
const zone = (process.env.T3_TUNNEL_ZONE || "").trim().toLowerCase();
const mapPath = defaultMapPath();
const url = (name) => `https://${name}.${zone}/`;

const unexpose = process.argv[2] === "--unexpose";
const args = process.argv.slice(unexpose ? 3 : 2);

const fail = (message) => {
  console.error(`${unexpose ? "t3-unexpose" : "t3-expose"}: ${message}`);
  process.exit(1);
};

const readMap = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(mapPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    return fail(`cannot read ${mapPath}: ${err.message}`);
  }
};

const writeMap = (map) => {
  NodeFS.mkdirSync(NodePath.dirname(mapPath), { recursive: true, mode: 0o700 });
  const tmp = `${mapPath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tmp, mapPath);
};

const toName = (arg) => {
  const name = String(arg || "")
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/^https?:\/\//, "");
  const bare = zone && name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
  if (!names.includes(bare))
    fail(
      `${arg} is not a tunnel name; use one of ${names.join(", ") || "(none: T3_TUNNEL_NAMES is unset)"}`,
    );
  return bare;
};

const listening = (port) =>
  new Promise((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

if (!names.length || !zone) fail("T3_TUNNEL_NAMES and T3_TUNNEL_ZONE must be set");

if (args[0] === "--list" || (!unexpose && args.length === 0)) {
  const map = readMap();
  for (const name of names) {
    console.log(
      `${name.padEnd(8)} ${map[name] ? String(map[name]).padEnd(6) : "free  "} ${url(name)}`,
    );
  }
} else if (unexpose) {
  if (args.length !== 1) fail("usage: t3-unexpose <name>");
  const name = toName(args[0]);
  const map = readMap();
  if (!map[name]) fail(`${name} is not exposed`);
  delete map[name];
  writeMap(map);
  console.log(`${url(name)} no longer serves anything`);
} else {
  if (args.length !== 2) fail("usage: t3-expose <name> <port> | t3-expose --list");
  const name = toName(args[0]);
  const port = Number(args[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail(`${args[1]} is not a port (1-65535)`);
  const routerPort = Number(process.env.T3_ROUTER_PORT || 8787);
  if (port === routerPort) fail(`port ${port} is the tunnel router itself`);
  if (!(await listening(port)))
    fail(`nothing listens on 127.0.0.1:${port}; bind the server to 127.0.0.1 or 0.0.0.0 first`);
  // Read after the slow probe, so agents exposing at once rarely lose an entry.
  const map = readMap();
  const holder = Object.keys(map).find((n) => map[n] === port && n !== name);
  if (holder) fail(`port ${port} is already exposed on ${holder}; t3-unexpose ${holder} first`);
  if (map[name] && map[name] !== port)
    fail(`${name} already serves port ${map[name]}; t3-unexpose ${name} first`);
  writeMap({ ...map, [name]: port });
  console.log(url(name));
  console.log(
    "Behind Cloudflare Access: only Akiva and Aman (PIN by email) or a service token get through.",
  );
}
