import { describe, expect, it } from "@effect/vitest";
import type { CodeIntelError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";

import * as CodeIntel from "./CodeIntel.ts";
import {
  countOf,
  forkRequest,
  inScenario,
  isAlive,
  makeGate,
  makeWorkspace,
  noWorkspaceStarted,
  startedPids,
  waitForMethod,
  writeFiles,
  type LogEntry,
  type Scenario,
} from "./testing/harness.ts";

const MINUTE = 60_000;
const IDLE_TIMEOUT = 15 * MINUTE;

const at = (line: number, character: number) => ({ line, character });
const isExit = (entry: LogEntry) => entry.text === "Language server exited";
const isFailedStart = (entry: LogEntry) => entry.text === "Language server failed to start";

const hoverAt = (cwd: string, path = "app.py") =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.hover({ document: { cwd, path }, position: at(0, 1) }),
  );

const definitionAt = (cwd: string, path = "app.py", line = 0, character = 1) =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.definition({
      document: { cwd, path },
      position: at(line, character),
      kind: "definition",
    }),
  );

const stateOf = (cwd: string, languageId = "python") =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) => codeIntel.status({ cwd })).pipe(
    Effect.map((status) => status.servers.find((server) => server.languageId === languageId)!),
  );

const restart = (cwd: string, languageId?: string) =>
  Effect.flatMap(CodeIntel.CodeIntel, (codeIntel) =>
    codeIntel.restart({ cwd, ...(languageId === undefined ? {} : { languageId }) }),
  );

/** The one process that gets to misbehave; a server started after it answers normally. */
const misbehaveOnce = (s: Scenario, ...flags: ReadonlyArray<string>) => {
  s.flags.push(...flags, `--once-file=${s.recordFile("once")}`);
};

/** A hover that ends in a crash, once the pool has seen the exit. */
const crashingHover = (s: Scenario, cwd: string) =>
  Effect.gen(function* () {
    const from = s.mark();
    const error = yield* hoverAt(cwd).pipe(Effect.flip);
    yield* s.waitForLog(isExit, from);
    return error;
  });

describe("LanguageServerPool", () => {
  describe("states", () => {
    it.effect("is indexing while a document has just opened, and ready once it settles", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          expect(yield* stateOf(cwd)).toMatchObject({
            state: "stopped",
            name: "fake",
            version: "1.2.3",
          });
          expect(noWorkspaceStarted(s.record)).toBe(true);

          yield* hoverAt(cwd);
          expect((yield* stateOf(cwd)).state).toBe("indexing");

          yield* TestClock.adjust(2_999);
          expect((yield* stateOf(cwd)).state).toBe("indexing");
          yield* TestClock.adjust(1);
          expect((yield* stateOf(cwd)).state).toBe("ready");
        }),
      ),
    );

    it.effect(
      "starts one server for requests that arrive together, however their fibers interleave",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            // Released together, the requests take turns in step; each limit moves where a turn ends.
            const limits = Array.from({ length: 29 }, (_, index) => index + 3);
            for (const [index, limit] of limits.entries()) {
              const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
              const gate = makeGate(3);
              s.resolveGate = gate;
              const requests = yield* Effect.forEach([1, 2, 3], () =>
                forkRequest(
                  hoverAt(cwd).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, limit)),
                ),
              );
              yield* Deferred.await(gate.began);
              s.resolveGate = undefined;
              yield* Deferred.succeed(gate.letGo, undefined);
              for (const request of requests) {
                expect((yield* request.outcome)._tag).toBe("Success");
              }
              expect(startedPids(s.record)).toHaveLength(index + 1);
              yield* restart(cwd);
            }
          }),
        ),
    );

    it.effect("is indexing for as long as the server reports progress", () =>
      inScenario({ flags: ["--progress"] }, () =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "def LOADED\n" });
          yield* hoverAt(cwd, "app.py");
          yield* TestClock.adjust(10_000);
          expect((yield* stateOf(cwd)).state).toBe("indexing");

          // The server ends its progress as it answers this.
          yield* definitionAt(cwd, "app.py", 0, 5);
          expect((yield* stateOf(cwd)).state).toBe("ready");
        }),
      ),
    );

    it.effect(
      "asks again every 250 ms while the server loads, and answers empty once it settled",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n", "other.py": "greet\n" });

            const definition = yield* forkRequest(definitionAt(cwd));
            yield* waitForMethod(s.record, "textDocument/definition");
            // The server answers in order, so this answer arrives after the empty definition one.
            // Another document: the first request on app.py holds its lock while it loops.
            yield* hoverAt(cwd, "other.py");
            expect(yield* definition.settled).toBe(false);
            yield* writeFiles(cwd, { "lib.py": "def greet\n" });
            yield* TestClock.adjust(250);

            expect(yield* definition.outcome).toMatchObject({
              _tag: "Success",
              value: { locations: [{ path: "lib.py" }] },
            });
            expect(countOf(s.record, "textDocument/definition")).toBe(2);

            yield* TestClock.adjust(3_000);
            const empty = yield* definitionAt(cwd, "app.py", 0, 20);
            expect(empty.locations).toEqual([]);
            expect(countOf(s.record, "textDocument/definition")).toBe(3);
          }),
        ),
    );

    it.effect("is unavailable while the binary is missing, and starts once it is there", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          s.missing.add("python");
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });

          const error = yield* hoverAt(cwd).pipe(Effect.flip);
          expect(error.reason).toBe("server_unavailable");
          expect((yield* stateOf(cwd)).state).toBe("unavailable");
          expect(noWorkspaceStarted(s.record)).toBe(true);

          s.missing.clear();
          expect((yield* stateOf(cwd)).state).toBe("stopped");
          expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
        }),
      ),
    );
  });

  describe("failed starts", () => {
    it.effect("says why a server exited while starting, with what it wrote to stderr", () =>
      inScenario({ flags: ["--exit-on-initialize=3", "--stderr=boom"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const from = s.mark();

          const error = yield* hoverAt(cwd).pipe(Effect.flip);

          expect(error.reason).toBe("server_failed");
          expect(error.message).toContain("refused `initialize`");
          expect(error.message).toContain("boom");
          const log = yield* s.waitForLog(isFailedStart, from);
          expect(log.fields).toMatchObject({ languageId: "python", stage: expect.any(String) });
          expect(yield* stateOf(cwd)).toMatchObject({ state: "failed", message: error.message });
          expect(s.heldWatchers()).toBe(0);
        }),
      ),
    );

    it.effect("kills a server that does not speak UTF-16 positions, and says so", () =>
      inScenario({ flags: ["--encoding=utf-8"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const from = s.mark();

          const error = yield* hoverAt(cwd).pipe(Effect.flip);

          expect(error.reason).toBe("server_failed");
          expect(error.message).toContain("does not support UTF-16 positions");
          const log = yield* s.waitForLog(isFailedStart, from);
          expect(log.fields).toMatchObject({ stage: "encoding" });
          const [pid] = startedPids(s.record);
          expect(isAlive(pid!)).toBe(false);
        }),
      ),
    );

    it.effect("fails a request when the server exits right after it answered initialize", () =>
      inScenario({ flags: ["--exit-after-initialize=5"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const from = s.mark();

          const error = yield* hoverAt(cwd).pipe(Effect.flip);
          yield* s.waitForLog((entry) => isExit(entry) || isFailedStart(entry), from);

          expect(error.reason).toBe("server_failed");
          expect((yield* stateOf(cwd)).state).toBe("failed");
          expect(isAlive(startedPids(s.record)[0]!)).toBe(false);
        }),
      ),
    );

    it.effect("kills a server that does not answer initialize in 30 seconds", () =>
      inScenario({ flags: ["--hang-initialize"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const hover = yield* forkRequest(hoverAt(cwd));
          yield* waitForMethod(s.record, "initialize");
          const [pid] = startedPids(s.record);

          // The request's own deadline is 10 s; the start goes on without it.
          yield* TestClock.adjust(10_000);
          expect(yield* hover.outcome).toMatchObject({
            _tag: "Failure",
            error: { reason: "timeout" },
          });
          expect((yield* stateOf(cwd)).state).toBe("starting");
          expect(isAlive(pid!)).toBe(true);

          const from = s.mark();
          yield* TestClock.adjust(19_999);
          expect((yield* stateOf(cwd)).state).toBe("starting");
          yield* TestClock.adjust(1);
          const log = yield* s.waitForLog(isFailedStart, from);

          expect(log.fields).toMatchObject({ stage: "initialize_timeout" });
          expect(yield* stateOf(cwd)).toMatchObject({
            state: "failed",
            message: expect.stringContaining("did not answer `initialize` in time"),
          });
          expect(isAlive(pid!)).toBe(false);
        }),
      ),
    );

    it.effect("never lets a failing language server fail another language or root", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [`--record=${s.record}`, "--exit-on-initialize=1"]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`]);
          const first = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
          const second = yield* makeWorkspace({ "app.ts": "greet\n" });

          const failed = yield* hoverAt(first, "app.py").pipe(Effect.flip);
          const sameRoot = yield* hoverAt(first, "app.ts");
          const otherRoot = yield* hoverAt(second, "app.ts");

          expect(failed.reason).toBe("server_failed");
          expect(sameRoot.markdown).toBe("**greet**");
          expect(otherRoot.markdown).toBe("**greet**");
          expect(startedPids(typescript)).toHaveLength(2);
        }),
      ),
    );
  });

  describe("crashes", () => {
    it.effect(
      "fails the request in flight when the server exits, and starts a new one for the next",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            misbehaveOnce(s, "--crash-on=textDocument/hover");
            const cwd = yield* makeWorkspace({ "app.py": "greet\n" });

            const error = yield* crashingHover(s, cwd);

            expect(error.reason).toBe("server_failed");
            const failed = yield* stateOf(cwd);
            expect(failed.state).toBe("failed");
            expect(failed.message).toContain("exited (code 7)");
            expect(isAlive(startedPids(s.record)[0]!)).toBe(false);
            expect(s.heldWatchers()).toBe(0);

            expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
            expect(startedPids(s.record)).toHaveLength(2);
            expect((yield* stateOf(cwd)).state).toBe("indexing");
          }),
        ),
    );

    it.effect("holds a crashed server's place until its child is cleaned up", () =>
      inScenario({}, (s) => {
        const gate = makeGate();
        return Effect.gen(function* () {
          misbehaveOnce(s, "--crash-on=textDocument/hover");
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          s.watcherRelease = gate;
          const from = s.mark();
          expect((yield* hoverAt(cwd).pipe(Effect.flip)).reason).toBe("server_failed");
          yield* Deferred.await(gate.began);

          // Not `failed` yet: a request now would start a second server beside the first.
          expect((yield* stateOf(cwd)).state).toBe("stopped");
          const next = yield* forkRequest(hoverAt(cwd));
          yield* Deferred.succeed(gate.letGo, undefined);

          expect(yield* next.outcome).toMatchObject({
            _tag: "Success",
            value: { markdown: "**greet**" },
          });
          const exitAt = s.history.findIndex((entry, index) => index >= from && isExit(entry));
          const restartAt = s.history.findLastIndex(
            (entry) => entry.text === "Language server started",
          );
          expect(exitAt).toBeGreaterThan(-1);
          expect(restartAt).toBeGreaterThan(exitAt);
          expect(startedPids(s.record)).toHaveLength(2);
        }).pipe(Effect.ensuring(Deferred.succeed(gate.letGo, undefined)));
      }),
    );

    it.effect("kills a server whose connection broke, and starts a new one for the next", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          misbehaveOnce(s, "--bad-frame-on=textDocument/hover");
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });

          const error = yield* crashingHover(s, cwd);

          expect(error.reason).toBe("server_failed");
          expect((yield* stateOf(cwd)).message).toContain("connection broke");
          expect(isAlive(startedPids(s.record)[0]!)).toBe(false);
          expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
          expect(startedPids(s.record)).toHaveLength(2);
        }),
      ),
    );

    it.effect("latches failed on the third exit in ten minutes, until a restart", () =>
      inScenario({ flags: ["--crash-on=textDocument/hover"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          for (let crash = 0; crash < 3; crash += 1) {
            expect((yield* crashingHover(s, cwd)).reason).toBe("server_failed");
          }

          const latched = yield* hoverAt(cwd).pipe(Effect.flip);
          expect(latched.reason).toBe("server_failed");
          expect(latched.message).toContain("restart language servers to try again");
          expect(startedPids(s.record)).toHaveLength(3);
          expect((yield* stateOf(cwd)).state).toBe("failed");

          // Time does not clear it; the server could start if it were asked to.
          s.flags = [`--record=${s.record}`];
          yield* TestClock.adjust(60 * MINUTE);
          expect((yield* hoverAt(cwd).pipe(Effect.flip)).message).toContain(
            "restart language servers",
          );
          expect(startedPids(s.record)).toHaveLength(3);

          expect((yield* restart(cwd)).servers.find((x) => x.languageId === "python")?.state).toBe(
            "stopped",
          );
          expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
          expect(startedPids(s.record)).toHaveLength(4);
        }),
      ),
    );

    it.effect.each([
      [10 * MINUTE - 1, true],
      [10 * MINUTE, false],
    ] as const)(
      "counts an exit toward the latch for ten minutes: a third exit $0 ms after the first latches: $1",
      ([spacing, latches]) =>
        inScenario({ flags: ["--crash-on=textDocument/hover"] }, (s) =>
          Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
            yield* crashingHover(s, cwd);
            yield* crashingHover(s, cwd);
            yield* TestClock.adjust(spacing);
            yield* crashingHover(s, cwd);

            const next = yield* hoverAt(cwd).pipe(Effect.flip);

            expect(next.message.includes("restart language servers")).toBe(latches);
            expect(startedPids(s.record)).toHaveLength(latches ? 3 : 4);
          }),
        ),
    );

    it.effect("latches one root and language and leaves the others alone", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [
            `--record=${s.record}`,
            "--crash-on=textDocument/hover",
          ]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`]);
          const first = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
          const second = yield* makeWorkspace({ "app.py": "def greet\ngreet\n" });
          for (let crash = 0; crash < 3; crash += 1) yield* crashingHover(s, first);

          const latched = yield* definitionAt(first, "app.py").pipe(Effect.flip);
          const sameRootOtherLanguage = yield* hoverAt(first, "app.ts");
          const otherRoot = yield* definitionAt(second, "app.py", 1);

          expect(latched.message).toContain("restart language servers");
          expect(sameRootOtherLanguage.markdown).toBe("**greet**");
          expect(otherRoot.locations).toHaveLength(1);
        }),
      ),
    );

    it.effect("clears the latch when code intelligence is turned off and on again", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [
            `--record=${s.record}`,
            "--crash-on=textDocument/hover",
          ]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`]);
          const cwd = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
          for (let crash = 0; crash < 3; crash += 1) yield* crashingHover(s, cwd);
          // A live server after the latched one, to know the switch has been through every slot.
          yield* hoverAt(cwd, "app.ts");
          expect((yield* hoverAt(cwd).pipe(Effect.flip)).message).toContain(
            "restart language servers",
          );

          const from = s.mark();
          yield* s.setEnabled(false);
          yield* s.waitForStop("off", from);
          yield* s.setEnabled(true);
          s.flagsByLanguage.set("python", [`--record=${s.record}`]);

          expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
        }),
      ),
    );
  });

  describe("failed starts in a row", () => {
    it.effect("waits 5 seconds before the third start, and latches when that one fails too", () =>
      inScenario({ flags: ["--exit-on-initialize=1"] }, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "def greet\n" });
          const symbols = () => codeIntel.documentSymbols({ document: { cwd, path: "app.py" } });

          expect((yield* symbols().pipe(Effect.flip)).reason).toBe("server_failed");
          expect((yield* symbols().pipe(Effect.flip)).reason).toBe("server_failed");
          expect(startedPids(s.record)).toHaveLength(2);

          yield* Queue.clear(s.resolved);
          const third = yield* forkRequest(symbols());
          yield* Queue.take(s.resolved);
          expect((yield* stateOf(cwd)).state).toBe("starting");
          yield* TestClock.adjust(4_999);
          expect(yield* third.settled).toBe(false);
          expect(startedPids(s.record)).toHaveLength(2);
          yield* TestClock.adjust(1);
          expect(yield* third.outcome).toMatchObject({
            _tag: "Failure",
            error: { reason: "server_failed" },
          });
          expect(startedPids(s.record)).toHaveLength(3);

          const latched = yield* symbols().pipe(Effect.flip);
          expect(latched.message).toContain("restart language servers");
          expect(startedPids(s.record)).toHaveLength(3);
        }),
      ),
    );
  });

  describe("request deadlines", () => {
    const document = (cwd: string) => ({ cwd, path: "app.py" });
    const position = at(0, 1);
    const calls: ReadonlyArray<
      readonly [
        string,
        string,
        number,
        (
          codeIntel: CodeIntel.CodeIntel["Service"],
          cwd: string,
        ) => Effect.Effect<unknown, CodeIntelError>,
      ]
    > = [
      [
        "definition",
        "textDocument/definition",
        10_000,
        (c, cwd) => c.definition({ document: document(cwd), position, kind: "definition" }),
      ],
      [
        "hover",
        "textDocument/hover",
        10_000,
        (c, cwd) => c.hover({ document: document(cwd), position }),
      ],
      [
        "documentHighlights",
        "textDocument/documentHighlight",
        10_000,
        (c, cwd) => c.documentHighlights({ document: document(cwd), position }),
      ],
      [
        "references",
        "textDocument/references",
        30_000,
        (c, cwd) =>
          c.references({ document: document(cwd), position, includeDeclaration: true, limit: 10 }),
      ],
      [
        "documentSymbols",
        "textDocument/documentSymbol",
        30_000,
        (c, cwd) => c.documentSymbols({ document: document(cwd) }),
      ],
      [
        "semanticTokens",
        "textDocument/semanticTokens/full",
        30_000,
        (c, cwd) => c.semanticTokens({ document: document(cwd) }),
      ],
      [
        "workspaceSymbols",
        "workspace/symbol",
        30_000,
        (c, cwd) => c.workspaceSymbols({ cwd, query: "greet", limit: 10 }),
      ],
    ];

    it.effect.each(calls)("$0 answers timeout after exactly $2 ms", ([, method, deadline, call]) =>
      inScenario({ flags: [`--ignore=${method}`] }, (s) =>
        Effect.gen(function* () {
          const codeIntel = yield* CodeIntel.CodeIntel;
          const cwd = yield* makeWorkspace({ "app.py": "def greet\ngreet\n" });
          const request = yield* forkRequest(call(codeIntel, cwd));
          yield* waitForMethod(s.record, method);

          yield* TestClock.adjust(deadline - 1);
          expect(yield* request.settled).toBe(false);
          yield* TestClock.adjust(1);

          expect(yield* request.outcome).toMatchObject({
            _tag: "Failure",
            error: { reason: "timeout" },
          });
          expect((yield* stateOf(cwd)).state).not.toBe("failed");
        }),
      ),
    );

    it.effect("does not let a hung request fail another request on the same server", () =>
      inScenario({ flags: ["--ignore=textDocument/hover"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\ndef greet\n" });
          // The first request on a document holds its lock; later ones at that revision share it.
          yield* definitionAt(cwd);
          const hover = yield* forkRequest(hoverAt(cwd));
          yield* waitForMethod(s.record, "textDocument/hover");

          const found = yield* definitionAt(cwd);
          yield* TestClock.adjust(10_000);

          expect(found.locations).toHaveLength(1);
          expect(yield* hover.outcome).toMatchObject({
            _tag: "Failure",
            error: { reason: "timeout" },
          });
        }),
      ),
    );
  });

  describe("requests that time out in a row", () => {
    const timeOut = (s: Scenario, cwd: string, nth: number) =>
      Effect.gen(function* () {
        const hover = yield* forkRequest(hoverAt(cwd));
        yield* waitForMethod(s.record, "textDocument/hover", nth);
        yield* TestClock.adjust(10_000);
        expect(yield* hover.outcome).toMatchObject({
          _tag: "Failure",
          error: { reason: "timeout" },
        });
      });

    it.effect("kills a settled server that answers nothing three times, and starts a new one", () =>
      inScenario({ flags: ["--ignore=textDocument/hover"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\ndef greet\n" });
          const from = s.mark();
          yield* timeOut(s, cwd, 1);
          yield* timeOut(s, cwd, 2);
          expect((yield* stateOf(cwd)).state).not.toBe("failed");
          yield* timeOut(s, cwd, 3);

          yield* s.waitForStop("timeouts", from);
          expect(yield* stateOf(cwd)).toMatchObject({
            state: "failed",
            message: expect.stringContaining("stopped answering (3 requests timed out)"),
          });
          const [pid] = startedPids(s.record);
          expect(isAlive(pid!)).toBe(false);
          expect(s.heldWatchers()).toBe(0);

          expect((yield* definitionAt(cwd)).locations).toHaveLength(1);
          expect(startedPids(s.record)).toHaveLength(2);
        }),
      ),
    );

    it.effect("starts counting again after an answer", () =>
      inScenario({ flags: ["--ignore=textDocument/hover"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\ndef greet\n" });
          yield* timeOut(s, cwd, 1);
          yield* timeOut(s, cwd, 2);
          expect((yield* definitionAt(cwd)).locations).toHaveLength(1);
          yield* timeOut(s, cwd, 3);
          yield* timeOut(s, cwd, 4);

          expect((yield* definitionAt(cwd)).locations).toHaveLength(1);
          expect(startedPids(s.record)).toHaveLength(1);
          expect(isAlive(startedPids(s.record)[0]!)).toBe(true);
        }),
      ),
    );

    it.effect("does not count timeouts of a server that is still loading", () =>
      inScenario({ flags: ["--ignore=textDocument/hover", "--progress"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "def LOADED\n" });
          for (let nth = 1; nth <= 4; nth += 1) yield* timeOut(s, cwd, nth);

          expect(startedPids(s.record)).toHaveLength(1);
          expect((yield* stateOf(cwd)).state).toBe("indexing");
        }),
      ),
    );

    it.effect("counts timeouts of a server whose progress has run for five minutes", () =>
      inScenario({ flags: ["--ignore=textDocument/hover", "--progress"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "def LOADED\n" });
          const from = s.mark();
          yield* timeOut(s, cwd, 1);
          yield* TestClock.adjust(5 * MINUTE);
          expect((yield* stateOf(cwd)).state).toBe("ready");
          for (let nth = 2; nth <= 4; nth += 1) yield* timeOut(s, cwd, nth);

          yield* s.waitForStop("timeouts", from);
          expect((yield* stateOf(cwd)).state).toBe("failed");
        }),
      ),
    );
  });

  describe("idle servers", () => {
    it.effect("stops a server after 15 minutes without a request, and closes its watcher", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd);
          const [pid] = startedPids(s.record);
          expect(s.heldWatchers()).toBeGreaterThan(0);

          yield* TestClock.adjust(IDLE_TIMEOUT - 1);
          expect((yield* stateOf(cwd)).state).toBe("ready");
          expect(isAlive(pid!)).toBe(true);
          const from = s.mark();
          yield* TestClock.adjust(1);
          yield* s.waitForStop("idle", from);

          expect((yield* stateOf(cwd)).state).toBe("stopped");
          expect(isAlive(pid!)).toBe(false);
          expect(s.heldWatchers()).toBe(0);

          expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
          expect(startedPids(s.record)).toHaveLength(2);
        }),
      ),
    );

    it.effect("counts the 15 minutes from the last request", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd);
          yield* TestClock.adjust(10 * MINUTE);
          yield* hoverAt(cwd);

          yield* TestClock.adjust(IDLE_TIMEOUT - 1);
          expect((yield* stateOf(cwd)).state).toBe("ready");
          const from = s.mark();
          yield* TestClock.adjust(1);
          yield* s.waitForStop("idle", from);

          expect(startedPids(s.record)).toHaveLength(1);
          expect((yield* stateOf(cwd)).state).toBe("stopped");
        }),
      ),
    );

    it.effect("does not count the status call as use", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd);
          yield* TestClock.adjust(10 * MINUTE);
          yield* stateOf(cwd);

          const from = s.mark();
          yield* TestClock.adjust(5 * MINUTE);
          yield* s.waitForStop("idle", from);
        }),
      ),
    );
  });

  describe("the cap of four live servers", () => {
    const roots = (count: number) =>
      Effect.forEach(Array.from({ length: count }), () => makeWorkspace({ "app.py": "greet\n" }));

    it.effect("stops the least recently used server for a fifth, and again for a sixth", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const [r1, r2, r3, r4, r5, r6] = yield* roots(6);
          for (const root of [r1!, r2!, r3!, r4!]) {
            yield* hoverAt(root);
            yield* TestClock.adjust(1);
          }
          const first = startedPids(s.record);
          expect(first).toHaveLength(4);

          const from = s.mark();
          yield* hoverAt(r5!);
          yield* s.waitForStop("evicted", from);
          const afterFifth = startedPids(s.record);
          expect(afterFifth).toHaveLength(5);
          expect(isAlive(first[0]!)).toBe(false);
          expect(first.slice(1).every(isAlive)).toBe(true);
          expect((yield* stateOf(r1!)).state).toBe("stopped");

          // r2 is used again, so r3 is now the one that has waited longest.
          yield* TestClock.adjust(1);
          yield* hoverAt(r2!);
          yield* TestClock.adjust(1);
          const sixth = s.mark();
          yield* hoverAt(r6!);
          yield* s.waitForStop("evicted", sixth);

          const all = startedPids(s.record);
          expect(all).toHaveLength(6);
          expect(isAlive(first[2]!)).toBe(false);
          expect([first[1]!, first[3]!, afterFifth[4]!, all[5]!].every(isAlive)).toBe(true);
          expect(all.filter(isAlive)).toHaveLength(4);
        }),
      ),
    );

    it.effect(
      "stops one server for requests that arrive together at a fifth root, however their fibers interleave",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            for (const root of yield* roots(4)) {
              yield* hoverAt(root);
              yield* TestClock.adjust(1);
            }
            // Each round is a new root over a full cap; each limit moves where a turn ends.
            const limits = Array.from({ length: 29 }, (_, index) => index + 3);
            for (const limit of limits) {
              const [root] = yield* roots(1);
              const from = s.mark();
              const gate = makeGate(3);
              s.resolveGate = gate;
              const requests = yield* Effect.forEach([1, 2, 3], () =>
                forkRequest(
                  hoverAt(root!).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, limit)),
                ),
              );
              yield* Deferred.await(gate.began);
              s.resolveGate = undefined;
              yield* Deferred.succeed(gate.letGo, undefined);
              for (const request of requests) {
                expect((yield* request.outcome)._tag).toBe("Success");
              }

              expect(
                s.history.slice(from).filter((entry) => entry.fields.reason === "evicted"),
              ).toHaveLength(1);
              expect(startedPids(s.record).filter(isAlive)).toHaveLength(4);
              yield* TestClock.adjust(1);
            }
          }),
        ),
    );

    it.effect("counts every language toward the cap", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const typescript = s.recordFile("typescript");
          s.flagsByLanguage.set("python", [`--record=${s.record}`]);
          s.flagsByLanguage.set("typescript", [`--record=${typescript}`]);
          const [a, b, c] = yield* roots(3);
          yield* writeFiles(a!, { "app.ts": "greet\n" });
          yield* hoverAt(a!, "app.ts");
          yield* TestClock.adjust(1);
          for (const root of [a!, b!, c!]) {
            yield* hoverAt(root);
            yield* TestClock.adjust(1);
          }
          const typescriptPid = startedPids(typescript)[0]!;
          expect(isAlive(typescriptPid)).toBe(true);

          const [d] = yield* roots(1);
          const from = s.mark();
          yield* hoverAt(d!);
          yield* s.waitForStop("evicted", from);

          expect(isAlive(typescriptPid)).toBe(false);
        }),
      ),
    );

    it.effect(
      "answers a request waiting on a server that is stopped for a newer one with server_unavailable",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            const typescript = s.recordFile("typescript");
            s.flagsByLanguage.set("python", [`--record=${s.record}`]);
            s.flagsByLanguage.set("typescript", [`--record=${typescript}`, "--hang-initialize"]);
            const [a, b, c, d, e] = yield* roots(5);
            yield* writeFiles(a!, { "app.ts": "greet\n" });

            const hung = yield* forkRequest(hoverAt(a!, "app.ts"));
            yield* waitForMethod(typescript, "initialize");
            yield* TestClock.adjust(1);
            for (const root of [b!, c!, d!]) {
              yield* hoverAt(root);
              yield* TestClock.adjust(1);
            }
            expect(startedPids(s.record)).toHaveLength(3);

            const from = s.mark();
            yield* hoverAt(e!);
            yield* s.waitForStop("evicted", from);

            expect(yield* hung.outcome).toMatchObject({
              _tag: "Failure",
              error: { reason: "server_unavailable" },
            });
            expect(isAlive(startedPids(typescript)[0]!)).toBe(false);
          }),
        ),
    );
  });

  describe("planned stops while a request is in flight", () => {
    const hangFirstHover = (s: Scenario) => misbehaveOnce(s, "--ignore=textDocument/hover");

    it.effect("retries the request once on a fresh server after a restart", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          hangFirstHover(s);
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const hover = yield* forkRequest(hoverAt(cwd));
          yield* waitForMethod(s.record, "textDocument/hover");

          yield* restart(cwd);

          expect(yield* hover.outcome).toMatchObject({
            _tag: "Success",
            value: { markdown: "**greet**" },
          });
          const pids = startedPids(s.record);
          expect(pids).toHaveLength(2);
          expect(isAlive(pids[0]!)).toBe(false);
          expect(isAlive(pids[1]!)).toBe(true);
        }),
      ),
    );

    it.effect("retries only once", () =>
      inScenario({ flags: ["--ignore=textDocument/hover"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const hover = yield* forkRequest(hoverAt(cwd));
          yield* waitForMethod(s.record, "textDocument/hover");
          yield* restart(cwd);
          yield* waitForMethod(s.record, "textDocument/hover", 2);
          yield* restart(cwd);

          expect(yield* hover.outcome).toMatchObject({
            _tag: "Failure",
            error: { reason: "server_failed" },
          });
          expect(startedPids(s.record)).toHaveLength(2);
        }),
      ),
    );

    it.effect("retries when the least recently used server is evicted under it", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          hangFirstHover(s);
          const [r1, r2, r3, r4, r5] = yield* Effect.forEach(Array.from({ length: 5 }), () =>
            makeWorkspace({ "app.py": "greet\n" }),
          );
          const hover = yield* forkRequest(hoverAt(r1!));
          yield* waitForMethod(s.record, "textDocument/hover");
          for (const root of [r2!, r3!, r4!]) {
            yield* TestClock.adjust(1);
            yield* hoverAt(root);
          }
          yield* TestClock.adjust(1);
          yield* hoverAt(r5!);

          expect(yield* hover.outcome).toMatchObject({
            _tag: "Success",
            value: { markdown: "**greet**" },
          });
        }),
      ),
    );

    it.effect("retries when a changed manifest restarts the server", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          hangFirstHover(s);
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const from = s.mark();
          const hover = yield* forkRequest(hoverAt(cwd));
          yield* waitForMethod(s.record, "textDocument/hover");

          yield* writeFiles(cwd, { "pyproject.toml": "[project]\nname = 'x'\n" });
          yield* s.waitForStop("dependencies", from);

          expect(yield* hover.outcome).toMatchObject({
            _tag: "Success",
            value: { markdown: "**greet**" },
          });
          expect(startedPids(s.record)).toHaveLength(2);
        }),
      ),
    );
  });

  describe("the off switch", () => {
    it.effect(
      "stops live servers, answers server_unavailable, and starts again when turned on",
      () =>
        inScenario({}, (s) =>
          Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
            yield* hoverAt(cwd);
            yield* hoverAt(cwd, "app.ts");
            const live = startedPids(s.record);
            expect(live).toHaveLength(2);

            const from = s.mark();
            yield* s.setEnabled(false);
            let stops = 0;
            yield* s.waitForLog(
              (entry) =>
                entry.text === "Language server stopped" &&
                entry.fields.reason === "off" &&
                ++stops === 2,
              from,
            );

            const codeIntel = yield* CodeIntel.CodeIntel;
            const off = yield* codeIntel.status({ cwd });
            const rows = off.servers;
            // An older client reads the rows alone: they still say why nothing answers.
            expect(off.enabled).toBe(false);
            expect(rows.map((row) => row.state)).toEqual(["unavailable", "unavailable"]);
            expect(rows[0]!.message).toContain("turned off");
            expect((yield* codeIntel.restart({ cwd })).enabled).toBe(false);
            expect(live.some(isAlive)).toBe(false);
            expect(s.heldWatchers()).toBe(0);
            const refused = yield* hoverAt(cwd).pipe(Effect.flip);
            expect(refused.reason).toBe("server_unavailable");
            expect(refused.message).toContain("turned off");
            expect((yield* definitionAt(cwd, "app.ts").pipe(Effect.flip)).reason).toBe(
              "server_unavailable",
            );
            expect(startedPids(s.record)).toHaveLength(2);

            yield* s.setEnabled(true);
            expect((yield* codeIntel.status({ cwd })).enabled).toBe(true);
            expect((yield* hoverAt(cwd)).markdown).toBe("**greet**");
            expect(startedPids(s.record)).toHaveLength(3);
          }),
        ),
    );

    it.effect(
      "answers every request server_unavailable when it starts turned off, and status starts nothing",
      () =>
        inScenario({ settings: { codeIntel: { enabled: false } } }, (s) =>
          Effect.gen(function* () {
            const codeIntel = yield* CodeIntel.CodeIntel;
            const cwd = yield* makeWorkspace({ "app.py": "def greet\n" });

            const states = (yield* codeIntel.status({ cwd })).servers.map((row) => row.state);
            const errors = yield* Effect.all([
              hoverAt(cwd).pipe(Effect.flip),
              codeIntel.documentSymbols({ document: { cwd, path: "app.py" } }).pipe(Effect.flip),
              codeIntel.workspaceSymbols({ cwd, query: "greet", limit: 5 }).pipe(Effect.flip),
            ]);

            const install = yield* codeIntel
              .installServer({ languageId: "python" })
              .pipe(Effect.flip);

            expect(states).toEqual(["unavailable", "unavailable"]);
            expect(errors.map((error) => error.reason)).toEqual([
              "server_unavailable",
              "server_unavailable",
              "server_unavailable",
            ]);
            expect(install.reason).toBe("server_unavailable");
            expect(s.installs).toEqual([]);
            expect(noWorkspaceStarted(s.record)).toBe(true);
          }),
        ),
    );

    it.effect(
      "starts nothing for a request that was looking for its binary when it was turned off",
      () =>
        inScenario({}, (s) => {
          const gate = makeGate();
          return Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
            yield* hoverAt(cwd, "app.ts");
            s.resolveGate = gate;
            const hover = yield* forkRequest(hoverAt(cwd));
            yield* Deferred.await(gate.began);

            const from = s.mark();
            yield* s.setEnabled(false);
            yield* s.waitForStop("off", from);
            yield* Deferred.succeed(gate.letGo, undefined);

            expect(yield* hover.outcome).toMatchObject({
              _tag: "Failure",
              error: { reason: "server_unavailable" },
            });
            expect(startedPids(s.record)).toHaveLength(1);
          }).pipe(Effect.ensuring(Deferred.succeed(gate.letGo, undefined)));
        }),
    );

    it.effect("answers a request in flight when it is turned off with server_unavailable", () =>
      inScenario({ flags: ["--ignore=textDocument/hover"] }, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          const from = s.mark();
          const hover = yield* forkRequest(hoverAt(cwd));
          yield* waitForMethod(s.record, "textDocument/hover");

          yield* s.setEnabled(false);

          expect(yield* hover.outcome).toMatchObject({
            _tag: "Failure",
            error: { reason: "server_unavailable" },
          });
          yield* s.waitForStop("off", from);
          expect(isAlive(startedPids(s.record)[0]!)).toBe(false);
        }),
      ),
    );

    it.effect("never starts a server for status", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
          yield* stateOf(cwd);
          yield* stateOf(cwd, "typescript");
          yield* restart(cwd);

          expect(noWorkspaceStarted(s.record)).toBe(true);
        }),
      ),
    );
  });

  describe("nothing is left running", () => {
    it.effect("stops every server when the service ends", () =>
      Effect.gen(function* () {
        const pids = yield* inScenario({}, (s) =>
          Effect.gen(function* () {
            const first = yield* makeWorkspace({ "app.py": "greet\n", "app.ts": "greet\n" });
            const second = yield* makeWorkspace({ "app.py": "greet\n" });
            yield* hoverAt(first);
            yield* hoverAt(first, "app.ts");
            yield* hoverAt(second);
            const started = startedPids(s.record);
            expect(started).toHaveLength(3);
            expect(started.every(isAlive)).toBe(true);
            return started;
          }),
        );

        expect(pids.some(isAlive)).toBe(false);
      }),
    );

    it.effect("stops a server that is still starting when the service ends", () =>
      Effect.gen(function* () {
        const pids = yield* inScenario({ flags: ["--hang-initialize"] }, (s) =>
          Effect.gen(function* () {
            const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
            yield* forkRequest(hoverAt(cwd));
            yield* waitForMethod(s.record, "initialize");
            return startedPids(s.record);
          }),
        );

        expect(pids).toHaveLength(1);
        expect(isAlive(pids[0]!)).toBe(false);
      }),
    );

    it.effect("leaves no process after a restart", () =>
      inScenario({}, (s) =>
        Effect.gen(function* () {
          const cwd = yield* makeWorkspace({ "app.py": "greet\n" });
          yield* hoverAt(cwd);
          yield* restart(cwd);
          yield* hoverAt(cwd);
          yield* restart(cwd);

          const pids = startedPids(s.record);
          expect(pids).toHaveLength(2);
          expect(pids.some(isAlive)).toBe(false);
        }),
      ),
    );
  });
});
