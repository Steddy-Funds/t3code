// @effect-diagnostics nodeBuiltinImport:off -- the tests edit a scratch tree by hand, as an editor would.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as CodeIntel from "./CodeIntel.ts";
import {
  countOf,
  forkRequest,
  inScenario,
  isAlive,
  makeWorkspace,
  methodsOf,
  recorded,
  startedPids,
  waitForMethod,
  waitForRecord,
  writeFiles,
  type RecordedMessage,
} from "./testing/harness.ts";

const hoverAt = (cwd: string, path: string) =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.hover({ document: { cwd, path }, position: { line: 0, character: 1 } }),
  );

const definitionAt = (cwd: string, path: string) =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.definition({
      document: { cwd, path },
      position: { line: 0, character: 1 },
      kind: "definition",
    }),
  );

const watchedChanges = (messages: ReadonlyArray<RecordedMessage>) =>
  messages
    .filter((message) => message.method === "workspace/didChangeWatchedFiles")
    .flatMap((message) => message.params?.changes as Array<{ uri: string; type: number }>);

const uriOf = (cwd: string, path: string) => `file://${NodePath.join(cwd, path)}`;

const waitForChange = (file: string, uri: string, type: number) =>
  waitForRecord(file, (messages) =>
    watchedChanges(messages).some((change) => change.uri === uri && change.type === type),
  );

describe("ServerSession", () => {
  describe("syncing documents", () => {
    it.effect("opens a document once with the text on disk and reuses it at the same revision", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "build/app.py": "greet\ndef greet\n" });

          yield* hoverAt(cwd, "build/app.py");
          yield* hoverAt(cwd, "build/app.py");
          yield* definitionAt(cwd, "build/app.py");

          const opened = recorded(s.record).filter((m) => m.method === "textDocument/didOpen");
          expect(opened).toHaveLength(1);
          expect(opened[0]!.params?.textDocument).toMatchObject({
            uri: uriOf(cwd, "build/app.py"),
            languageId: "python",
            version: 1,
            text: "greet\ndef greet\n",
          });
          expect(countOf(s.record, "textDocument/didChange")).toBe(0);
        }),
      ),
    );

    it.effect("sends the new text before the request when the file changed, and the answer is about it", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "build/app.py": "greet\n" });
          expect((yield* hoverAt(cwd, "build/app.py")).markdown).toBe("**greet**");

          yield* writeFiles(cwd, { "build/app.py": "fresh\n" });
          const answer = yield* hoverAt(cwd, "build/app.py");

          expect(answer.markdown).toBe("**fresh**");
          const messages = recorded(s.record);
          const changeAt = messages.findIndex((m) => m.method === "textDocument/didChange");
          const secondHover = messages.findLastIndex((m) => m.method === "textDocument/hover");
          expect(messages[changeAt]!.params).toMatchObject({
            textDocument: { uri: uriOf(cwd, "build/app.py"), version: 2 },
            contentChanges: [{ text: "fresh\n" }],
          });
          expect(changeAt).toBeGreaterThan(-1);
          expect(changeAt).toBeLessThan(secondHover);
          expect(countOf(s.record, "textDocument/didOpen")).toBe(1);
        }),
      ),
    );

    it.effect("runs requests at one revision together, and a sync after them", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({
            "build/held.py": "WAIT_FOR_WATCHED\ndef WAIT_FOR_WATCHED\n",
            "other.py": "greet\n",
          });
          yield* hoverAt(cwd, "build/held.py");

          const held = yield* forkRequest(definitionAt(cwd, "build/held.py"));
          yield* waitForMethod(s.record, "textDocument/definition");
          const sameRevision = yield* hoverAt(cwd, "build/held.py");
          expect(sameRevision.markdown).toBe("**WAIT_FOR_WATCHED**");
          expect(yield* held.settled).toBe(false);

          yield* writeFiles(cwd, { "build/held.py": "changed\n" });
          const changed = yield* forkRequest(hoverAt(cwd, "build/held.py"));
          // Another document is not held up by it.
          yield* hoverAt(cwd, "other.py");
          expect(yield* changed.settled).toBe(false);
          expect(countOf(s.record, "textDocument/didChange")).toBe(0);

          // The server answers the held request after it hears of a change.
          yield* writeFiles(cwd, { "trigger.py": "x\n" });
          expect(yield* held.outcome).toMatchObject({ _tag: "Success" });
          expect(yield* changed.outcome).toMatchObject({
            _tag: "Success",
            value: { markdown: "**changed**" },
          });

          const messages = recorded(s.record);
          const released = messages.findIndex((m) => m.method === "workspace/didChangeWatchedFiles");
          const changeAt = messages.findIndex((m) => m.method === "textDocument/didChange");
          expect(released).toBeGreaterThan(-1);
          expect(changeAt).toBeGreaterThan(released);
        }),
      ),
    );

    it.effect("closes the least recently used document when a server holds more than 24", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const files = Object.fromEntries(
            Array.from({ length: 26 }, (_, index) => [`d${index}.py`, `word${index}\n`] as const),
          );
          const cwd = yield* makeWorkspace(files);
          const closed = () =>
            recorded(s.record)
              .filter((m) => m.method === "textDocument/didClose")
              .map((m) => m.params?.textDocument.uri as string);

          for (let index = 0; index < 24; index += 1) {
            yield* hoverAt(cwd, `d${index}.py`);
            yield* TestClock.adjust(1);
          }
          expect(closed()).toEqual([]);

          // d0 is used again, so d1 has gone unused longest.
          yield* hoverAt(cwd, "d0.py");
          yield* TestClock.adjust(1);
          yield* hoverAt(cwd, "d24.py");
          yield* waitForMethod(s.record, "textDocument/didClose");
          expect(closed()).toEqual([uriOf(cwd, "d1.py")]);

          yield* TestClock.adjust(1);
          yield* hoverAt(cwd, "d25.py");
          yield* waitForMethod(s.record, "textDocument/didClose", 2);
          expect(closed()).toEqual([uriOf(cwd, "d1.py"), uriOf(cwd, "d2.py")]);
          expect(countOf(s.record, "textDocument/didOpen")).toBe(26);

          // A closed document opens again, with the text on disk.
          expect((yield* hoverAt(cwd, "d1.py")).markdown).toBe("**word1**");
          expect(countOf(s.record, "textDocument/didOpen")).toBe(27);
        }),
      ),
    );
  });

  describe("watching the workspace", () => {
    it.effect("tells the server about a created, changed and deleted file, and closes the changed one", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd, "app.py");

          yield* writeFiles(cwd, { "lib.py": "def lib\n" });
          yield* waitForChange(s.record, uriOf(cwd, "lib.py"), 1);

          yield* writeFiles(cwd, { "app.py": "fresh\n" });
          yield* waitForChange(s.record, uriOf(cwd, "app.py"), 2);
          yield* waitForMethod(s.record, "textDocument/didClose");
          expect(recorded(s.record).find((m) => m.method === "textDocument/didClose")?.params).toMatchObject({
            textDocument: { uri: uriOf(cwd, "app.py") },
          });

          NodeFS.rmSync(NodePath.join(cwd, "lib.py"));
          yield* waitForChange(s.record, uriOf(cwd, "lib.py"), 3);

          // The closed document comes back with what is on disk now.
          expect((yield* hoverAt(cwd, "app.py")).markdown).toBe("**fresh**");
          const opens = recorded(s.record).filter((m) => m.method === "textDocument/didOpen");
          expect(opens).toHaveLength(2);
          expect(opens[1]!.params?.textDocument).toMatchObject({ text: "fresh\n", version: 1 });
          expect(countOf(s.record, "textDocument/didChange")).toBe(0);
        }),
      ),
    );

    it.effect("tells the server only about files its language watches", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd, "app.py");

          yield* writeFiles(cwd, { "notes.txt": "hello\n", "node_modules/pkg/index.py": "x\n" });
          yield* writeFiles(cwd, { "lib.py": "def lib\n" });
          yield* waitForChange(s.record, uriOf(cwd, "lib.py"), 1);

          const uris = watchedChanges(recorded(s.record)).map((change) => change.uri);
          expect(uris.every((uri) => uri.endsWith(".py"))).toBe(true);
          expect(uris.some((uri) => uri.includes("node_modules"))).toBe(false);
        }),
      ),
    );

    it.effect("stops the server when a manifest changes, and starts a new one for the next request", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd, "app.py");
          const [pid] = startedPids(s.record);
          const from = s.mark();

          yield* writeFiles(cwd, { "pyproject.toml": "[project]\nname = 'x'\n" });
          yield* s.waitForStop("dependencies", from);

          expect(isAlive(pid!)).toBe(false);
          expect(s.heldWatchers()).toBe(0);
          expect(methodsOf(s.record)).not.toContain("workspace/didChangeWatchedFiles");
          expect((yield* hoverAt(cwd, "app.py")).markdown).toBe("**greet**");
          expect(startedPids(s.record)).toHaveLength(2);
        }),
      ),
    );
  });
});
