import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LspConnection from "./LspConnection.ts";

class BrokenPipe extends Schema.TaggedError<BrokenPipe>()("BrokenPipe", {}) {}

describe("LspConnection", () => {
  it.effect("fails a waiting request when the close stops its own fibers, however they interleave", () =>
    Effect.gen(function* () {
      for (let limit = 3; limit <= 64; limit += 1) {
        yield* Effect.gen(function* () {
          const scope = yield* Scope.make();
          const connection = yield* LspConnection.make({
            input: Stream.never,
            output: Sink.forEach(() => Effect.fail(new BrokenPipe())),
            onRequest: () => Effect.succeed(null),
            onNotification: () => Effect.void,
          }).pipe(Scope.provide(scope));
          // The pool closes a server's scope as soon as its connection closes.
          yield* connection.closed.pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
            Effect.forkChild,
          );

          const error = yield* connection
            .request("textDocument/hover")
            .pipe(Effect.asVoid, Effect.flip);

          expect(error).toMatchObject({ _tag: "LspConnectionClosedError", reason: "write_failed" });
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, limit));
      }
    }),
  );
});
