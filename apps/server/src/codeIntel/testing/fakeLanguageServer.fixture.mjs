// A language server for tests: speaks LSP over stdio and understands a toy language.
//
//   def NAME            defines NAME (a function)
//   class NAME          defines NAME (a class); indented `def` lines are its methods
//   extern NAME PATH N  NAME is defined at line N (1-based) of the file PATH
//   any other word      a reference to the definition of that name
//
// Like the real servers it keeps what it read from disk until it is told the file changed
// (`workspace/didChangeWatchedFiles`), and an open document hides the file on disk.
//
// Switches (argv):
//   --record=FILE          append every message received, one JSON object a line
//   --hang-initialize      never answer `initialize`
//   --exit-on-initialize=N exit with code N instead of answering `initialize`
//   --exit-after-initialize=N  answer `initialize`, then exit with code N
//   --crash-on=METHOD      exit with code 7 when METHOD arrives
//   --ignore=METHOD        never answer METHOD
//   --once-file=FILE       makes --crash-on and --ignore apply to the first process that gets to
//                          create FILE only, so a server started after it answers normally
//   --ignore-shutdown      never answer `shutdown` and ignore `exit` and a closed pipe: only a signal ends it
//   --encoding=NAME        claim this position encoding
//   --no-semantic-tokens   advertise no semantic tokens
//   --progress             report load progress from the first `didOpen` until `$/test/loaded`
//   --stderr=TEXT          write TEXT to stderr at start
//   --fuzzy-symbols        answer workspace symbols in reverse alphabetical order
//   --extensions=a,b       read only files with these extensions from disk (default py,pyi,ts,tsx,js)
//
// With --record the file also gets `$/test/started` (with the pid) when the process starts and
// `$/test/exited` when it ends by itself or by SIGTERM, so a test sees a process's life as events.
//
// Words with a meaning in any document:
//   WAIT_FOR_WATCHED       a definition request on it is answered after the next watched-files event
//   LOADED                 a definition request on it ends the load progress
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.replace(/^--/, "").split("=");
    return [name, value.join("=") || "true"];
  }),
);
const flag = (name) => flags.get(name);

if (flag("stderr")) process.stderr.write(`${flag("stderr")}\n`);

// `--once-file`: the first process to find the file missing creates it and misbehaves.
let chosenToMisbehave;
const misbehaves = () => {
  if (chosenToMisbehave !== undefined) return chosenToMisbehave;
  const onceFile = flag("once-file");
  if (onceFile === undefined || !existsSync(onceFile)) {
    if (onceFile !== undefined) writeFileSync(onceFile, "");
    chosenToMisbehave = true;
  } else {
    chosenToMisbehave = false;
  }
  return chosenToMisbehave;
};

let root = process.cwd();
const openDocuments = new Map();
const diskCache = new Map();
const watchedWaiters = [];
let buffer = Buffer.alloc(0);
let nextRequestId = 1;
let loading = false;

const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};
const record = (message) => {
  if (flag("record")) appendFileSync(flag("record"), `${JSON.stringify(message)}\n`);
};

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
const SKIPPED = new Set(["node_modules", ".git", ".venv"]);
const served = new RegExp(`\\.(${(flag("extensions") ?? "py,pyi,ts,tsx,js").split(",").join("|")})$`);

const sourceFiles = (directory) => {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) files.push(...sourceFiles(entryPath));
    } else if (served.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
};

const textOf = (uri) => {
  if (openDocuments.has(uri)) return openDocuments.get(uri);
  if (!diskCache.has(uri)) {
    try {
      diskCache.set(uri, readFileSync(fileURLToPath(uri), "utf8"));
    } catch {
      diskCache.set(uri, null);
    }
  }
  return diskCache.get(uri);
};

const allUris = () => [
  ...new Set([...sourceFiles(root).map((file) => pathToFileURL(file).href), ...openDocuments.keys()]),
];

const wordAt = (uri, position) => {
  const line = (textOf(uri) ?? "").split("\n")[position.line] ?? "";
  for (const match of line.matchAll(WORD)) {
    if (match.index <= position.character && position.character <= match.index + match[0].length) {
      return match[0];
    }
  }
  return undefined;
};

const range = (line, start, length) => ({
  start: { line, character: start },
  end: { line, character: start + length },
});

const definitionsOf = (name) => {
  const locations = [];
  for (const uri of allUris()) {
    const lines = (textOf(uri) ?? "").split("\n");
    lines.forEach((line, index) => {
      const declared = /^\s*(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (declared && declared[2] === name) {
        locations.push({ uri, range: range(index, line.indexOf(name), name.length) });
      }
      const external = /^extern\s+(\S+)\s+(\S+)\s+(\d+)/.exec(line);
      if (external && external[1] === name) {
        locations.push({
          uri: pathToFileURL(external[2]).href,
          range: range(Number(external[3]) - 1, 0, 0),
        });
      }
    });
  }
  return locations;
};

const occurrencesOf = (name, uris) => {
  const locations = [];
  for (const uri of uris) {
    (textOf(uri) ?? "").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(WORD)) {
        if (match[0] === name) locations.push({ uri, range: range(index, match.index, name.length) });
      }
    });
  }
  return locations;
};

const symbolsOf = (uri) => {
  const symbols = [];
  let currentClass;
  (textOf(uri) ?? "").split("\n").forEach((line, index) => {
    const declared = /^(\s*)(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (!declared) return;
    const [, indent, keyword, name] = declared;
    const symbol = {
      name,
      kind: keyword === "class" ? 5 : indent.length > 0 && currentClass ? 6 : 12,
      range: range(index, 0, line.length),
      selectionRange: range(index, line.indexOf(name), name.length),
      children: [],
    };
    if (keyword === "class") {
      currentClass = symbol;
      symbols.push(symbol);
    } else if (indent.length > 0 && currentClass) {
      currentClass.children.push(symbol);
    } else {
      currentClass = undefined;
      symbols.push(symbol);
    }
  });
  return symbols;
};

const endLoading = () => {
  if (!loading) return;
  loading = false;
  send({ method: "$/progress", params: { token: "load", value: { kind: "end" } } });
};

const capabilities = () => ({
  positionEncoding: flag("encoding") ?? "utf-16",
  textDocumentSync: 1,
  definitionProvider: true,
  typeDefinitionProvider: true,
  referencesProvider: true,
  hoverProvider: true,
  documentHighlightProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  ...(flag("no-semantic-tokens")
    ? {}
    : {
        semanticTokensProvider: {
          legend: { tokenTypes: ["class", "function"], tokenModifiers: ["definition"] },
          full: true,
          range: true,
        },
      }),
});

const answer = (method, params) => {
  switch (method) {
    case "initialize":
      root = params.rootPath ?? root;
      return { capabilities: capabilities(), serverInfo: { name: "fake", version: "1.2.3" } };
    case "shutdown":
      return null;
    case "textDocument/definition":
    case "textDocument/typeDefinition": {
      const name = wordAt(params.textDocument.uri, params.position);
      if (name === "LOADED") endLoading();
      return name === undefined ? [] : definitionsOf(name);
    }
    case "textDocument/references": {
      const name = wordAt(params.textDocument.uri, params.position);
      if (name === undefined) return [];
      const declared = definitionsOf(name);
      return occurrencesOf(name, allUris()).filter(
        (location) =>
          params.context.includeDeclaration ||
          !declared.some(
            (other) =>
              other.uri === location.uri && other.range.start.line === location.range.start.line,
          ),
      );
    }
    case "textDocument/documentHighlight": {
      const name = wordAt(params.textDocument.uri, params.position);
      return name === undefined
        ? []
        : occurrencesOf(name, [params.textDocument.uri]).map((location, index) => ({
            range: location.range,
            kind: index === 0 ? 3 : 2,
          }));
    }
    case "textDocument/hover": {
      const name = wordAt(params.textDocument.uri, params.position);
      return name === undefined ? null : { contents: { kind: "markdown", value: `**${name}**` } };
    }
    case "textDocument/documentSymbol":
      return symbolsOf(params.textDocument.uri);
    case "workspace/symbol": {
      const symbols = allUris().flatMap((uri) =>
        symbolsOf(uri)
          .flatMap((symbol) => [symbol, ...symbol.children])
          .filter((symbol) => symbol.name.toLowerCase().includes(params.query.toLowerCase()))
          .map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            location: { uri, range: symbol.selectionRange },
          })),
      );
      symbols.sort((left, right) => left.name.localeCompare(right.name));
      return flag("fuzzy-symbols") ? symbols.reverse() : symbols;
    }
    case "textDocument/semanticTokens/full":
    case "textDocument/semanticTokens/range": {
      const data = [];
      let previousLine = 0;
      for (const symbol of symbolsOf(params.textDocument.uri).flatMap((s) => [s, ...s.children])) {
        const { line, character } = symbol.selectionRange.start;
        if (params.range && (line < params.range.start.line || line > params.range.end.line)) continue;
        data.push(line - previousLine, character, symbol.name.length, symbol.kind === 5 ? 0 : 1, 1);
        previousLine = line;
      }
      return { data };
    }
    default:
      return null;
  }
};

const notified = (method, params) => {
  switch (method) {
    case "initialized":
      send({ id: `s${nextRequestId++}`, method: "workspace/configuration", params: { items: [{ section: "js/ts" }, { section: "ty" }, { section: "unknown" }] } });
      send({ id: `s${nextRequestId++}`, method: "client/registerCapability", params: { registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: "**" }] } }] } });
      return;
    case "textDocument/didOpen":
      openDocuments.set(params.textDocument.uri, params.textDocument.text);
      if (flag("progress") && !loading) {
        loading = true;
        send({ id: `s${nextRequestId++}`, method: "window/workDoneProgress/create", params: { token: "load" } });
        send({ method: "$/progress", params: { token: "load", value: { kind: "begin", title: "Loading" } } });
      }
      return;
    case "textDocument/didChange":
      openDocuments.set(params.textDocument.uri, params.contentChanges.at(-1).text);
      return;
    case "textDocument/didClose":
      openDocuments.delete(params.textDocument.uri);
      diskCache.delete(params.textDocument.uri);
      return;
    case "workspace/didChangeWatchedFiles":
      for (const change of params.changes) diskCache.delete(change.uri);
      for (const waiter of watchedWaiters.splice(0)) waiter();
      return;
    case "exit":
      process.exit(0);
  }
};

const handle = (message) => {
  record(message);
  if (message.method === undefined) return; // an answer to one of our requests
  if (flag("crash-on") === message.method && misbehaves()) process.exit(7);
  if (flag("ignore-shutdown") && (message.method === "shutdown" || message.method === "exit")) return;
  if (message.id === undefined) return notified(message.method, message.params ?? {});
  if (message.method === "initialize") {
    if (flag("hang-initialize")) return;
    if (flag("exit-on-initialize")) process.exit(Number(flag("exit-on-initialize")));
  }
  if (flag("ignore") === message.method && misbehaves()) return;
  const respond = () => {
    send({ id: message.id, result: answer(message.method, message.params ?? {}) });
    if (message.method === "initialize" && flag("exit-after-initialize")) {
      process.exit(Number(flag("exit-after-initialize")));
    }
  };
  const waits =
    message.method === "textDocument/definition" &&
    wordAt(message.params.textDocument.uri, message.params.position) === "WAIT_FOR_WATCHED";
  if (waits) watchedWaiters.push(respond);
  else respond();
};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
// A language server exits when its client closes the pipe.
if (!flag("ignore-shutdown")) process.stdin.on("end", () => process.exit(0));
else process.stdin.resume();

record({ method: "$/test/started", params: { pid: process.pid, argv: process.argv.slice(2) } });
process.on("exit", () => record({ method: "$/test/exited", params: { pid: process.pid } }));
process.on("SIGTERM", () => process.exit(143));
