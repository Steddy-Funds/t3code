// @effect-diagnostics nodeBuiltinImport:off -- links and a file's bytes are laid out with node:fs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import type { CodeIntelError } from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as CodeIntel from "./CodeIntel.ts";
import {
  countOf,
  forkRequest,
  inScenario,
  isAlive,
  makeGate,
  makeScenario,
  makeWorkspace,
  methodsOf,
  noWorkspaceStarted,
  recorded,
  startedPids,
  UNKNOWN_WORKSPACE_PREFIX,
  waitForMethod,
  writeFiles,
} from "./testing/harness.ts";

const at = (line: number, character: number) => ({ line, character });

const openedPaths = (record: string, cwd: string) =>
  recorded(record)
    .filter((message) => message.method === "textDocument/didOpen")
    .map((message) =>
      NodePath.relative(
        cwd,
        NodeURL.fileURLToPath(
          (message.params as { textDocument: { uri: string } }).textDocument.uri,
        ),
      ),
    );

const reasonOf = (call: Effect.Effect<unknown, CodeIntelError>) =>
  call.pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "answered" }));

const hoverAt = (cwd: string, path: string, ifRevision?: string) =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.hover({
      document: { cwd, path, ...(ifRevision === undefined ? {} : { ifRevision }) },
      position: at(0, 1),
    }),
  );

const definitionAt = (cwd: string, path: string, line = 0, character = 1) =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.definition({
      document: { cwd, path },
      position: at(line, character),
      kind: "definition",
    }),
  );

/** Every call that takes a document, with `document` as the one thing that differs. */
const documentCalls = (document: { cwd: string; path: string; ifRevision?: string }) =>
  Effect.gen(function* () {
    const codeIntel = yield* CodeIntel.CodeIntel;
    const position = at(0, 1);
    return {
      definition: codeIntel.definition({ document, position, kind: "definition" }),
      references: codeIntel.references({
        document,
        position,
        includeDeclaration: true,
        limit: 10,
      }),
      documentHighlights: codeIntel.documentHighlights({ document, position }),
      hover: codeIntel.hover({ document, position }),
      documentSymbols: codeIntel.documentSymbols({ document }),
      semanticTokens: codeIntel.semanticTokens({ document }),
    };
  });

describe("CodeIntel", () => {
  describe("navigation", () => {
    it.effect("answers a definition in another file against the revision on disk", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const usage = "from lib import greet\ngreet\n";
          const cwd = yield* makeWorkspace({ "app.py": usage, "lib.py": "\ndef greet\n" });

          const result = yield* Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
            codeIntel.definition({
              document: { cwd, path: "app.py", ifRevision: fileContentRevision(usage) },
              position: at(1, 2),
              kind: "definition",
            }),
          );

          expect(result).toEqual({
            revision: fileContentRevision(usage),
            locations: [
              {
                path: "lib.py",
                external: false,
                range: { start: at(1, 4), end: at(1, 9) },
                lineText: "def greet",
              },
            ],
          });
        }),
      ),
    );

    it.effect("refuses a document whose text on disk is not the text shown", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const error = yield* hoverAt(cwd, "app.py", fileContentRevision("old text\n")).pipe(
            Effect.flip,
          );
          expect(error.reason).toBe("stale_document");
        }),
      ),
    );

    it.effect("tells the server only the file on disk, and stops it on restart", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "def greet\ngreet\n" });

          yield* codeIntel.hover({ document: { cwd, path: "app.py" }, position: at(1, 1) });
          const messages = recorded(s.record);
          const initialize = messages.find((message) => message.method === "initialize");
          const opened = messages.find((message) => message.method === "textDocument/didOpen");
          const [pid] = startedPids(s.record);

          expect(initialize?.params?.processId).toBe(NodeProcess.pid);
          expect(opened?.params?.textDocument).toMatchObject({ text: "def greet\ngreet\n" });
          expect(isAlive(pid!)).toBe(true);

          const restarted = yield* codeIntel.restart({ cwd });
          expect(restarted.servers.find((server) => server.languageId === "python")?.state).toBe(
            "stopped",
          );
          expect(isAlive(pid!)).toBe(false);
        }),
      ),
    );

    it.effect(
      "answers hover, highlights, symbols and references with the document's revision",
      () =>
        inScenario({}, () =>
          Effect.gen(function* () {
            const codeIntel = yield* CodeIntel.CodeIntel;
            const text = "def greet\ngreet\nclass Box\n";
            const cwd = yield* makeWorkspace({ "app.py": text });
            const revision = fileContentRevision(text);
            const document = { cwd, path: "app.py" };

            const hover = yield* codeIntel.hover({ document, position: at(1, 1) });
            const highlights = yield* codeIntel.documentHighlights({
              document,
              position: at(1, 1),
            });
            const symbols = yield* codeIntel.documentSymbols({ document });
            const references = yield* codeIntel.references({
              document,
              position: at(1, 1),
              includeDeclaration: true,
              limit: 10,
            });

            expect(hover).toEqual({ markdown: "**greet**", revision });
            expect(highlights.revision).toBe(revision);
            expect(highlights.ranges.map((entry) => entry.range.start.line)).toEqual([0, 1]);
            expect(symbols.revision).toBe(revision);
            expect(symbols.symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
              ["greet", "function"],
              ["Box", "class"],
            ]);
            expect(references.revision).toBe(revision);
            expect(references.locations).toHaveLength(2);
          }),
        ),
    );

    it.effect("answers a type definition, and nothing for a kind the server does not offer", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "greet\n", "lib.py": "def greet\n" });
          const document = { cwd, path: "app.py" };

          const typeDefinition = yield* codeIntel.definition({
            document,
            position: at(0, 1),
            kind: "typeDefinition",
          });
          const implementation = yield* codeIntel.definition({
            document,
            position: at(0, 1),
            kind: "implementation",
          });

          expect(typeDefinition.locations.map((location) => location.path)).toEqual(["lib.py"]);
          expect(implementation.locations).toEqual([]);
          expect(implementation.revision).toBe(fileContentRevision("greet\n"));
          expect(methodsOf(s.record)).toContain("textDocument/typeDefinition");
          expect(methodsOf(s.record)).not.toContain("textDocument/implementation");
        }),
      ),
    );

    it.effect("asks for the range of a document's semantic tokens only when given one", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const text = "def one\ndef two\n";
          const cwd = yield* makeWorkspace({ "app.py": text });
          const document = { cwd, path: "app.py" };

          const full = yield* codeIntel.semanticTokens({ document });
          const ranged = yield* codeIntel.semanticTokens({
            document,
            range: { start: at(1, 0), end: at(1, 8) },
          });

          expect(full.legend).toEqual({
            tokenTypes: ["class", "function"],
            tokenModifiers: ["definition"],
          });
          expect(full).toMatchObject({ data: [0, 4, 3, 1, 1, 1, 4, 3, 1, 1] });
          expect(ranged).toMatchObject({ data: [1, 4, 3, 1, 1] });
          expect(methodsOf(s.record)).toContain("textDocument/semanticTokens/full");
          expect(methodsOf(s.record)).toContain("textDocument/semanticTokens/range");
        }),
      ),
    );

    it.effect("answers a null legend when the server offers no semantic tokens", () =>
      inScenario({ flags: ["--no-semantic-tokens"] }, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "def one\n" });

          const result = yield* codeIntel.semanticTokens({ document: { cwd, path: "app.py" } });

          expect(result).toEqual({ legend: null, revision: fileContentRevision("def one\n") });
          expect(methodsOf(s.record).filter((m) => m?.includes("semanticTokens"))).toEqual([]);
        }),
      ),
    );
  });

  describe("roots", () => {
    it.effect("starts nothing, in any call, for a directory that is not a known workspace", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: UNKNOWN_WORKSPACE_PREFIX,
          });
          yield* writeFiles(cwd, { "app.py": "greet\n" });
          const calls = yield* documentCalls({ cwd, path: "app.py" });

          const reasons = yield* Effect.forEach(
            [
              ...Object.values(calls),
              codeIntel.workspaceSymbols({ cwd, query: "greet", limit: 10 }),
              codeIntel.status({ cwd }),
              codeIntel.restart({ cwd }),
            ],
            reasonOf,
          );

          expect(reasons).toEqual(Array.from({ length: 9 }, () => "path_not_allowed"));
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("remembers that a directory is known for 30 seconds, and a refusal not at all", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });

          yield* codeIntel.status({ cwd });
          yield* codeIntel.status({ cwd });
          expect(s.knownChecks).toBe(1);

          yield* TestClock.adjust(29_999);
          yield* codeIntel.status({ cwd });
          expect(s.knownChecks).toBe(1);

          yield* TestClock.adjust(1);
          yield* codeIntel.status({ cwd });
          expect(s.knownChecks).toBe(2);

          const unknown = yield* fileSystem.makeTempDirectoryScoped({
            prefix: UNKNOWN_WORKSPACE_PREFIX,
          });
          yield* codeIntel.status({ cwd: unknown }).pipe(Effect.flip);
          yield* codeIntel.status({ cwd: unknown }).pipe(Effect.flip);
          expect(s.knownChecks).toBe(4);
        }),
      ),
    );

    it.effect("refuses a known directory that does not exist", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace();

          const error = yield* codeIntel
            .definition({
              document: { cwd: NodePath.join(cwd, "gone"), path: "app.py" },
              position: at(0, 0),
              kind: "definition",
            })
            .pipe(Effect.flip);

          expect(error.reason).toBe("path_not_allowed");
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("serves a workspace named through a symlink as its real directory", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "def greet\ngreet\n" });
          const linked = NodePath.join(s.scratch, "linked");
          NodeFS.symlinkSync(cwd, linked);

          const result = yield* definitionAt(linked, "app.py", 1);

          expect(result.locations.map((location) => location.path)).toEqual(["app.py"]);
          const initialize = recorded(s.record).find((message) => message.method === "initialize");
          expect(initialize?.params?.rootPath).toBe(cwd);
        }),
      ),
    );
  });

  describe("documents", () => {
    it.effect(
      "counts the deadline from the request, so a slow workspace check times it out too",
      () =>
        inScenario({}, (s) => {
          const gate = makeGate();
          return Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
            s.knownGate = gate;
            const hover = yield* forkRequest(hoverAt(cwd, "app.py"));
            yield* Deferred.await(gate.began);
            yield* TestClock.adjust(10_000);

            expect(yield* hover.outcome).toMatchObject({
              _tag: "Failure",
              error: { reason: "timeout" },
            });
            expect(noWorkspaceStarted(s.record)).toBe(true);
          }).pipe(Effect.ensuring(Deferred.succeed(gate.letGo, undefined)));
        }),
    );

    it.effect("answers stale_document, before any server starts, whatever the call", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const calls = yield* documentCalls({
            cwd,
            path: "app.py",
            ifRevision: fileContentRevision("another text\n"),
          });

          const reasons = yield* Effect.forEach(Object.values(calls), reasonOf);

          expect(reasons).toEqual(Array.from({ length: 6 }, () => "stale_document"));
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("answers a matching ifRevision, and one answer's revision is the next one's", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const first = yield* hoverAt(cwd, "app.py");
          const second = yield* hoverAt(cwd, "app.py", first.revision);
          expect(second.revision).toBe(first.revision);
        }),
      ),
    );

    it.effect(
      "refuses a relative path that leaves the root, by a dot-dot or a link, and opens nothing",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
            const outside = NodePath.join(s.scratch, "outside.py");
            NodeFS.writeFileSync(outside, "greet\n");
            NodeFS.symlinkSync(outside, NodePath.join(cwd, "escape.py"));
            NodeFS.symlinkSync(s.scratch, NodePath.join(cwd, "scratch-link"));

            const outcomes = yield* Effect.forEach(
              ["../outside.py", "escape.py", "scratch-link/outside.py"],
              (path) =>
                hoverAt(cwd, path).pipe(
                  Effect.match({ onSuccess: () => "served", onFailure: (error) => error.reason }),
                ),
            );

            expect(outcomes).toEqual(Array.from({ length: 3 }, () => "path_not_allowed"));
            expect(noWorkspaceStarted(s.record)).toBe(true);
          }),
        ),
    );

    it.effect(
      "serves a file named by an absolute path outside the root, as projects.readFile does",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
            const outside = NodePath.join(s.scratch, "outside.py");
            NodeFS.writeFileSync(outside, "greet\n");

            expect((yield* hoverAt(cwd, outside)).markdown).toBe("**greet**");
          }),
        ),
    );

    it.effect("gives a server the real path of a file reached through a link inside the root", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "real/app.py": "greet\n" });
          NodeFS.symlinkSync(NodePath.join(cwd, "real"), NodePath.join(cwd, "alias"));

          yield* hoverAt(cwd, "alias/app.py");

          const opened = recorded(s.record).find((m) => m.method === "textDocument/didOpen");
          expect(opened?.params?.textDocument.uri).toBe(
            `file://${NodePath.join(cwd, "real/app.py")}`,
          );
        }),
      ),
    );

    it.effect("refuses the server's own secrets and state, though they lie inside the root", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
        const baseDir = NodePath.join(cwd, ".t3home");
        const s = yield* makeScenario({ baseDir });
        yield* writeFiles(baseDir, {
          "userdata/secrets/key.py": "greet\n",
          "userdata/state.sqlite.py": "greet\n",
          "userdata/notes.py": "greet\n",
        });

        yield* s.provide(
          Effect.gen(function* () {
            const reasons = yield* Effect.forEach(
              [
                ".t3home/userdata/secrets/key.py",
                ".t3home/userdata/state.sqlite.py",
                NodePath.join(baseDir, "userdata/secrets/key.py"),
              ],
              (path) =>
                hoverAt(cwd, path).pipe(
                  Effect.flip,
                  Effect.map((error) => error.reason),
                ),
            );
            expect(reasons).toEqual(Array.from({ length: 3 }, () => "path_not_allowed"));
            expect(noWorkspaceStarted(s.record)).toBe(true);

            const ordinary = yield* hoverAt(cwd, ".t3home/userdata/notes.py");
            expect(ordinary.markdown).toBe("**greet**");
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("answers not_found for a missing file and for a directory", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "dir.py/inner.py": "x\n" });

          const reasons = yield* Effect.forEach(["missing.py", "dir.py"], (path) =>
            hoverAt(cwd, path).pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            ),
          );

          expect(reasons).toEqual(["not_found", "not_found"]);
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("analyses a file of 1 MiB and refuses one byte more", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const limit = 1024 * 1024;
          const header = "greet";
          const cwd = yield* makeWorkspace({
            "exact.py": header + " ".repeat(limit - header.length),
            "over.py": header + " ".repeat(limit - header.length + 1),
          });

          const exact = yield* hoverAt(cwd, "exact.py");
          const error = yield* hoverAt(cwd, "over.py").pipe(Effect.flip);

          expect(exact.markdown).toBe("**greet**");
          expect(error.reason).toBe("file_too_large");
          expect(countOf(s.record, "textDocument/didOpen")).toBe(1);
        }),
      ),
    );

    it.effect("answers unsupported_language for a language nobody serves and for binary data", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "notes.txt": "greet\n" });
          NodeFS.writeFileSync(NodePath.join(cwd, "blob.py"), Buffer.from([0x67, 0, 0x68, 0]));

          const reasons = yield* Effect.forEach(["notes.txt", "missing.txt", "blob.py"], (path) =>
            hoverAt(cwd, path).pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            ),
          );

          expect(reasons).toEqual(Array.from({ length: 3 }, () => "unsupported_language"));
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("serves a file whose extension is in capitals", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "APP.PY": "greet\n" });
          expect((yield* hoverAt(cwd, "APP.PY")).markdown).toBe("**greet**");
        }),
      ),
    );

    it.effect("never gives a server a text a client sent", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          // The schema decodes a request to its own fields; a call that skips it still gets the disk.
          const smuggled = {
            document: { cwd, path: "app.py", text: "def planted\n", contents: "def planted\n" },
            position: at(0, 1),
          };

          yield* codeIntel.hover(smuggled);

          const opened = recorded(s.record).find((m) => m.method === "textDocument/didOpen");
          expect(opened?.params?.textDocument.text).toBe("greet\n");
        }),
      ),
    );
  });

  describe("locations", () => {
    it.effect("is relative inside the root and absolute, and external, outside it", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\nhelper\n" });
          const outside = NodePath.join(s.scratch, "elsewhere.py");
          NodeFS.writeFileSync(outside, "one\ntwo\ndef greet\n");
          yield* writeFiles(cwd, {
            "defs.py": `extern greet ${outside} 3\ndef helper\n`,
          });

          const outer = yield* definitionAt(cwd, "app.py", 0);
          const inner = yield* definitionAt(cwd, "app.py", 1);

          expect(outer.locations).toEqual([
            {
              path: outside,
              external: true,
              range: { start: at(2, 0), end: at(2, 0) },
              lineText: "def greet",
            },
          ]);
          expect(inner.locations).toEqual([
            {
              path: "defs.py",
              external: false,
              range: { start: at(1, 4), end: at(1, 10) },
              lineText: "def helper",
            },
          ]);
        }),
      ),
    );

    it.effect("marks third-party trees, relative paths included, as external", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({
            "node_modules/pkg/lib.py": "def lib\n",
            ".venv/lib/site-packages/pkg/mod.py": "def mod\n",
            "vendor/lib/third.py": "pass\n",
            "app.py": "lib\nmod\nthird\nours\n",
            "ours.py": "def ours\n",
          });
          yield* writeFiles(cwd, {
            "defs.py": [
              `extern lib ${cwd}/node_modules/pkg/lib.py 1`,
              `extern mod ${cwd}/.venv/lib/site-packages/pkg/mod.py 1`,
              `extern third ${cwd}/vendor/lib/third.py 1`,
            ].join("\n"),
          });
          s.python = {
            source: "root",
            libraryRoots: [
              { path: NodePath.join(cwd, "vendor/lib"), label: "vendored", kind: "site-packages" },
            ],
          };

          const results = yield* Effect.forEach([0, 1, 2, 3], (line) =>
            definitionAt(cwd, "app.py", line),
          );

          expect(
            results.map((result) => result.locations.map((l) => [l.path, l.external])),
          ).toEqual([
            [["node_modules/pkg/lib.py", true]],
            [[".venv/lib/site-packages/pkg/mod.py", true]],
            [["vendor/lib/third.py", true]],
            [["ours.py", false]],
          ]);
        }),
      ),
    );

    it.effect("reports a link leaving the root by the real path, and external", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const target = NodePath.join(s.scratch, "target.py");
          NodeFS.writeFileSync(target, "def greet\n");
          NodeFS.symlinkSync(s.scratch, NodePath.join(cwd, "out"));
          yield* writeFiles(cwd, { "defs.py": `extern greet ${cwd}/out/target.py 1\n` });

          const result = yield* definitionAt(cwd, "app.py");

          expect(result.locations).toEqual([
            {
              path: target,
              external: true,
              range: { start: at(0, 0), end: at(0, 0) },
              lineText: "def greet",
            },
          ]);
        }),
      ),
    );

    it.effect(
      "reads a line preview from disk, 400 characters at most, and none for an empty line",
      () =>
        inScenario({}, () =>
          Effect.gen(function* () {
            const long = `def ${"x".repeat(600)}`;
            const cwd = yield* makeWorkspace({ "app.py": "xxx\nblank\ngone\n" });
            yield* writeFiles(cwd, {
              "defs.py": [
                `extern xxx ${cwd}/target.py 1`,
                `extern blank ${cwd}/target.py 2`,
                `extern gone ${cwd}/target.py 9`,
              ].join("\n"),
              "target.py": `${long}\n\n`,
            });

            const [first, second, third] = yield* Effect.forEach([0, 1, 2], (line) =>
              definitionAt(cwd, "app.py", line),
            );

            expect(first?.locations[0]?.lineText).toHaveLength(400);
            expect(first?.locations[0]?.lineText).toBe(long.slice(0, 400));
            expect(second?.locations[0]).not.toHaveProperty("lineText");
            expect(third?.locations[0]).not.toHaveProperty("lineText");
          }),
        ),
    );

    it.effect("drops a location in the server's own files and keeps the others", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
        const baseDir = NodePath.join(cwd, ".t3home");
        const s = yield* makeScenario({ baseDir });
        yield* writeFiles(baseDir, {
          "userdata/secrets/key.py": "def secret\n",
          "userdata/state.sqlite.py": "def state\n",
        });
        yield* writeFiles(cwd, {
          "defs.py": [
            `extern greet ${baseDir}/userdata/secrets/key.py 1`,
            `extern greet ${baseDir}/userdata/state.sqlite.py 1`,
            "def greet",
          ].join("\n"),
        });

        const result = yield* s.provide(definitionAt(cwd, "app.py"));

        expect(result.locations.map((location) => location.path)).toEqual(["defs.py"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("honours a limit on references and says when it cut them", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "def greet\ngreet\ngreet\ngreet\n" });
          const ask = (limit: number, includeDeclaration: boolean) =>
            codeIntel.references({
              document: { cwd, path: "app.py" },
              position: at(1, 1),
              includeDeclaration,
              limit,
            });

          const cut = yield* ask(2, true);
          const exact = yield* ask(4, true);
          const without = yield* ask(10, false);

          expect(cut.locations).toHaveLength(2);
          expect(cut.truncated).toBe(true);
          expect(exact.locations).toHaveLength(4);
          expect(exact.truncated).toBe(false);
          expect(without.locations).toHaveLength(3);
          expect(without.truncated).toBe(false);
        }),
      ),
    );
  });

  describe("workspace symbols", () => {
    const WORDS = "def greet\ndef greeting\ndef greeter\ndef xgreet\ndef mygreet\nclass Gree\n";

    it.effect(
      "ranks an exact name, then a prefix, then the rest, whatever order the server used",
      () =>
        inScenario({ flags: ["--fuzzy-symbols"] }, () =>
          Effect.gen(function* () {
            const codeIntel = yield* CodeIntel.CodeIntel;
            const cwd = yield* makeWorkspace({ "app.py": WORDS });

            const result = yield* codeIntel.workspaceSymbols({ cwd, query: "greet", limit: 10 });
            const names = result.symbols.map((symbol) => symbol.name);

            expect(names[0]).toBe("greet");
            expect(names.slice(1, 3).toSorted()).toEqual(["greeter", "greeting"]);
            expect(names.slice(3).toSorted()).toEqual(["mygreet", "xgreet"]);
            expect(result.truncated).toBe(false);
            expect(result.symbols[0]).not.toHaveProperty("location.lineText");
          }),
        ),
    );

    it.effect("honours a limit and says when it cut the list", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": WORDS });
          const ask = (limit: number) => codeIntel.workspaceSymbols({ cwd, query: "greet", limit });

          const cut = yield* ask(2);
          const exact = yield* ask(5);

          expect(cut.symbols).toHaveLength(2);
          expect(cut.truncated).toBe(true);
          expect(exact.symbols).toHaveLength(5);
          expect(exact.truncated).toBe(false);
        }),
      ),
    );

    it.effect("keeps only the kinds asked for", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": WORDS });

          const classes = yield* codeIntel.workspaceSymbols({
            cwd,
            query: "gree",
            limit: 10,
            kinds: ["class"],
          });

          expect(classes.symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
            ["Gree", "class"],
          ]);
        }),
      ),
    );

    it.effect("asks the languages the root shows, to one folder down, and no others", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const python = s.recordFile("python");
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [`--record=${python}`, "--extensions=py"]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`, "--extensions=ts"]);
          const cwd = yield* makeWorkspace({
            "a.py": "def alpha_py\n",
            "sub/b.ts": "def alpha_ts\n",
          });

          const both = yield* codeIntel.workspaceSymbols({ cwd, query: "alpha", limit: 10 });

          expect(both.symbols.map((symbol) => symbol.name).toSorted()).toEqual([
            "alpha_py",
            "alpha_ts",
          ]);
          expect(startedPids(python)).toHaveLength(1);
          expect(startedPids(typescript)).toHaveLength(1);

          // One language that cannot answer leaves the others' answers.
          s.missing.add("python");
          yield* codeIntel.restart({ cwd });
          const typescriptOnly = yield* codeIntel.workspaceSymbols({
            cwd,
            query: "alpha",
            limit: 10,
          });
          expect(typescriptOnly.symbols.map((symbol) => symbol.name)).toEqual(["alpha_ts"]);
        }),
      ),
    );

    it.effect.each([
      ["two folders down", { "a.py": "def alpha\n", "deep/er/b.ts": "def alpha\n" }],
      ["a dot folder", { "a.py": "def alpha\n", ".hidden/b.ts": "def alpha\n" }],
      ["node_modules", { "a.py": "def alpha\n", "node_modules/b.ts": "def alpha\n" }],
    ] as const)("does not look for a language in $0", ([, files]) =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`]);
          const cwd = yield* makeWorkspace(files);

          const result = yield* codeIntel.workspaceSymbols({ cwd, query: "alpha", limit: 10 });

          expect(result.symbols.length).toBeGreaterThan(0);
          expect(noWorkspaceStarted(typescript)).toBe(true);
        }),
      ),
    );

    it.effect("takes a manifest alone as the sign of a language", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "package.json": "{}\n" });

          yield* codeIntel.workspaceSymbols({ cwd, query: "alpha", limit: 10 });

          expect(startedPids(s.record)).toHaveLength(1);
        }),
      ),
    );

    it.effect("asks the languages the root shows, not only the one already running", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const python = s.recordFile("python");
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [`--record=${python}`, "--extensions=py"]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`, "--extensions=ts"]);
          const cwd = yield* makeWorkspace({ "a.py": "def alpha_py\n", "b.ts": "def alpha_ts\n" });

          yield* hoverAt(cwd, "b.ts");
          const result = yield* codeIntel.workspaceSymbols({ cwd, query: "alpha", limit: 10 });

          expect(result.symbols.map((symbol) => symbol.name).toSorted()).toEqual([
            "alpha_py",
            "alpha_ts",
          ]);
          expect(startedPids(python)).toHaveLength(1);
          expect(startedPids(typescript)).toHaveLength(1);
        }),
      ),
    );

    it.effect("answers an empty list, and starts nothing, for a root that shows no language", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "notes.txt": "alpha\n" });

          const result = yield* codeIntel.workspaceSymbols({ cwd, query: "alpha", limit: 10 });

          expect(result).toEqual({ symbols: [], truncated: false });
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("opens a file of the root's project before a fresh tsc's first answer", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`, "--symbols-after-open"]);
          const cwd = yield* makeWorkspace({
            "tsconfig.json": '{ "include": ["src"] }\n',
            "src/billing/invoice.ts": "class Invoice\n",
          });

          const result = yield* codeIntel.workspaceSymbols({
            cwd,
            languageId: "typescript",
            query: "Invoice",
            limit: 10,
          });

          expect(result.symbols.map((symbol) => symbol.location.path)).toEqual([
            "src/billing/invoice.ts",
          ]);
        }),
      ),
    );

    const ALPHA = "def alpha\n";
    it.effect.each([
      [
        "the first file in the folder the tsconfig includes",
        {
          "tsconfig.json": '{ "include": ["src/**/*"] }\n',
          "vite.config.ts": ALPHA,
          "src/types.d.ts": ALPHA,
          "src/app/main.ts": ALPHA,
        },
        [],
        ["src/app/main.ts"],
      ],
      [
        "the file a tsconfig with comments lists",
        {
          "tsconfig.json": '// app\n{ "files": ["lib/main.ts",], }\n',
          "a.ts": ALPHA,
          "lib/main.ts": ALPHA,
        },
        [],
        ["lib/main.ts"],
      ],
      [
        "a file of the project a solution references",
        {
          "tsconfig.json": '{ "files": [], "references": [{ "path": "./packages/b" }] }\n',
          "packages/b/tsconfig.json": '{ "include": ["src"] }\n',
          "packages/b/src/b.ts": ALPHA,
        },
        [],
        ["packages/b/src/b.ts"],
      ],
      [
        "a file of each project a solution references",
        {
          "tsconfig.json":
            '{ "files": [], "references": [{ "path": "./packages/a" }, { "path": "./packages/b" }] }\n',
          "packages/a/tsconfig.json": '{ "include": ["src"] }\n',
          "packages/a/src/a.ts": ALPHA,
          "packages/b/tsconfig.json": '{ "include": ["src"] }\n',
          "packages/b/src/b.ts": ALPHA,
        },
        [],
        ["packages/a/src/a.ts", "packages/b/src/b.ts"],
      ],
      [
        "a file the include of a project's base names",
        {
          "tsconfig.json": '{ "extends": "./tsconfig.app.json" }\n',
          "tsconfig.app.json": '{ "include": ["src"] }\n',
          "vite.config.ts": ALPHA,
          "src/main.ts": ALPHA,
        },
        [],
        ["src/main.ts"],
      ],
      [
        "the projects that import the most of a workspace, none that one of them loads",
        {
          "evals/package.json": '{ "name": "evals" }\n',
          "evals/tsconfig.json": "{}\n",
          "evals/run.ts": ALPHA,
          "scripts/package.json": '{ "name": "scripts" }\n',
          "scripts/tsconfig.json": "{}\n",
          "scripts/build.ts": ALPHA,
          "apps/desktop/package.json": '{ "name": "desktop", "dependencies": { "contracts": "*" } }\n',
          "apps/desktop/tsconfig.json": "{}\n",
          "apps/desktop/main.ts": ALPHA,
          "apps/server/package.json":
            '{ "name": "server", "dependencies": { "contracts": "*", "shared": "*" }, "devDependencies": { "web": "*" } }\n',
          "apps/server/tsconfig.json": "{}\n",
          "apps/server/main.ts": ALPHA,
          "apps/web/package.json":
            '{ "name": "web", "dependencies": { "contracts": "*", "shared": "*", "ui": "*" } }\n',
          "apps/web/tsconfig.json": "{}\n",
          "apps/web/main.ts": ALPHA,
          "packages/contracts/package.json": '{ "name": "contracts", "exports": "./index.ts" }\n',
          "packages/contracts/tsconfig.json": "{}\n",
          "packages/contracts/index.ts": ALPHA,
          "packages/shared/package.json":
            '{ "name": "shared", "exports": "./index.ts", "dependencies": { "contracts": "*" } }\n',
          "packages/shared/tsconfig.json": "{}\n",
          "packages/shared/index.ts": ALPHA,
          "packages/ui/package.json":
            '{ "name": "ui", "main": "./index.ts", "dependencies": { "contracts": "*", "shared": "*" } }\n',
          "packages/ui/tsconfig.json": "{}\n",
          "packages/ui/index.ts": ALPHA,
        },
        [],
        ["apps/web/main.ts", "apps/server/main.ts", "apps/desktop/main.ts", "evals/run.ts"],
      ],
      [
        "one file of each project below a root that has none",
        {
          "apps/web/tsconfig.json": "{}\n",
          "apps/web/main.ts": ALPHA,
          "packages/ui/tsconfig.json": "{}\n",
          "packages/ui/index.ts": ALPHA,
          "scripts/build.ts": ALPHA,
        },
        [],
        ["apps/web/main.ts", "packages/ui/index.ts"],
      ],
      ["nothing for a root without a project", { "a.ts": ALPHA }, [], []],
      [
        "nothing more while a document is open",
        { "tsconfig.json": "{}\n", "a.ts": ALPHA, "b.ts": ALPHA },
        ["b.ts"],
        ["b.ts"],
      ],
    ] as const)("opens %s before tsc's first workspace answer", ([, files, openFirst, opened]) =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`]);
          const cwd = yield* makeWorkspace(files);
          for (const path of openFirst) yield* hoverAt(cwd, path);

          yield* codeIntel.workspaceSymbols({
            cwd,
            languageId: "typescript",
            query: "alpha",
            limit: 10,
          });

          expect(openedPaths(typescript, cwd)).toEqual(opened);
        }),
      ),
    );

    it.effect("lands on the name of a symbol its server places at the whole declaration", () =>
      inScenario({ flags: ["--symbol-full-range"] }, () =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({
            "models.py":
              '@register("Ledger")\n@dataclass\nclass Ledger\n    @property\n    def ledger_total\ndef ledger_free\n',
          });

          const result = yield* codeIntel.workspaceSymbols({ cwd, query: "ledger", limit: 10 });

          expect(result.symbols.map((symbol) => [symbol.name, symbol.location.range])).toEqual([
            ["Ledger", { start: at(2, 6), end: at(2, 12) }],
            ["ledger_free", { start: at(5, 4), end: at(5, 15) }],
            ["ledger_total", { start: at(4, 8), end: at(4, 20) }],
          ]);
          expect(result.symbols[0]).not.toHaveProperty("location.lineText");
        }),
      ),
    );

    it.effect("answers unsupported_language for a language it has no row for", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "a.py": "def alpha\n" });

          const error = yield* codeIntel
            .workspaceSymbols({ cwd, languageId: "cobol", query: "alpha", limit: 10 })
            .pipe(Effect.flip);

          expect(error.reason).toBe("unsupported_language");
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );
  });

  describe("status, restart and install", () => {
    it.effect("reports each language of a root without starting a server", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "a.py": "def alpha\n" });

          const status = yield* codeIntel.status({ cwd });

          expect(status.servers.map((server) => [server.languageId, server.state])).toEqual([
            ["python", "stopped"],
            ["typescript", "stopped"],
          ]);
          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );

    it.effect("lists the root's node_modules and each package's own, root first", () =>
      inScenario({}, () =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({
            "node_modules/react/index.js": "",
            "packages/b/node_modules/dep/index.js": "",
            "apps/web/node_modules/vite/index.js": "",
            "three/folders/down/node_modules/x/index.js": "",
            ".cache/node_modules/y/index.js": "",
          });

          const status = yield* codeIntel.status({ cwd });

          const typescript = status.servers.find((server) => server.languageId === "typescript");
          expect(typescript?.libraryRoots).toEqual(
            ["node_modules", "apps/web/node_modules", "packages/b/node_modules"].map((label) => ({
              path: NodePath.join(cwd, label),
              label,
              kind: "node_modules",
            })),
          );
        }),
      ),
    );

    it.effect("says unavailable, with the reason, for a language whose binary is missing", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          s.missing.add("python");
          const cwd = yield* makeWorkspace({ "a.py": "greet\n" });

          const status = yield* codeIntel.status({ cwd });
          const error = yield* hoverAt(cwd, "a.py").pipe(Effect.flip);

          const python = status.servers.find((server) => server.languageId === "python");
          expect(python).toMatchObject({
            state: "unavailable",
            message: "fake is not installed. Install it to navigate this language.",
          });
          expect(error.reason).toBe("server_unavailable");
          expect(noWorkspaceStarted(s.record)).toBe(true);

          s.missing.delete("python");
          expect((yield* hoverAt(cwd, "a.py")).markdown).toBe("**greet**");
        }),
      ),
    );

    it.effect("installs through the binaries, and says what a failed install left", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;

          const failed = yield* codeIntel.installServer({ languageId: "python" });
          s.installFails = false;
          const installed = yield* codeIntel.installServer({ languageId: "python" });
          const unknown = yield* codeIntel.installServer({ languageId: "cobol" }).pipe(Effect.flip);

          expect(failed).toMatchObject({ state: "unavailable" });
          expect(failed.message).toContain("download failed");
          expect(installed).toEqual({ state: "stopped" });
          expect(unknown.reason).toBe("unsupported_language");
          expect(s.installs).toEqual(["python", "python"]);
        }),
      ),
    );

    it.effect(
      "answers unsupported_language when told to restart a language it has no row for",
      () =>
        inScenario({}, () =>
          Effect.gen(function* () {
            const codeIntel = yield* CodeIntel.CodeIntel;
            const cwd = yield* makeWorkspace();

            const error = yield* codeIntel.restart({ cwd, languageId: "cobol" }).pipe(Effect.flip);

            expect(error.reason).toBe("unsupported_language");
          }),
        ),
    );

    it.effect("restarts one language and leaves the other's server running", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const python = s.recordFile("python");
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [`--record=${python}`, "--extensions=py"]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`, "--extensions=ts"]);
          const cwd = yield* makeWorkspace({ "a.py": "greet\n", "b.ts": "greet\n" });
          yield* hoverAt(cwd, "a.py");
          yield* hoverAt(cwd, "b.ts");
          yield* waitForMethod(typescript, "textDocument/didOpen");

          const status = yield* codeIntel.restart({ cwd, languageId: "python" });

          const states = Object.fromEntries(
            status.servers.map((entry) => [entry.languageId, entry.state]),
          );
          expect(states.python).toBe("stopped");
          expect(states.typescript).not.toBe("stopped");
          const [pythonPid] = startedPids(python);
          const [typescriptPid] = startedPids(typescript);
          expect(isAlive(pythonPid!)).toBe(false);
          expect(isAlive(typescriptPid!)).toBe(true);
        }),
      ),
    );
  });
});
