import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { encodeLspMessage, type LspFramingFailure, makeLspFrameDecoder } from "./LspFraming.ts";

/** The language server answered a request with a JSON-RPC error. */
export class LspResponseError extends Schema.TaggedError<LspResponseError>()("LspResponseError", {
  method: Schema.String,
  code: Schema.Number,
}) {
  override get message(): string {
    return `The language server refused '${this.method}' (code ${this.code}).`;
  }
}

export class LspConnectionClosedError extends Schema.TaggedError<LspConnectionClosedError>()(
  "LspConnectionClosedError",
  {
    reason: Schema.Literals(["ended", "read_failed", "write_failed", "framing"]),
    framing: Schema.optional(
      Schema.Literals(["header_too_large", "missing_content_length", "message_too_large"]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The language server connection closed (${this.framing ?? this.reason}).`;
  }
}

export type LspError = LspResponseError | LspConnectionClosedError;

const isConnectionClosed = Schema.is(LspConnectionClosedError);

export interface LspConnection {
  /** Interrupting the effect sends `$/cancelRequest`. */
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, LspError>;
  readonly notify: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<void, LspConnectionClosedError>;
  /** Completes once, when the connection ends for any reason. */
  readonly closed: Effect.Effect<LspConnectionClosedError>;
}

export interface LspConnectionOptions {
  /** The language server's stdout. */
  readonly input: Stream.Stream<Uint8Array, unknown>;
  /** The language server's stdin. */
  readonly output: Sink.Sink<void, Uint8Array, never, unknown>;
  /** Answers a server-to-client request; the result is sent back as is. */
  readonly onRequest: (method: string, params: unknown) => Effect.Effect<unknown>;
  /** Runs on the reader, in order: it must not block. */
  readonly onNotification: (method: string, params: unknown) => Effect.Effect<void>;
}

const JSON_RPC_INTERNAL_ERROR = -32603;

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, LspError>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBody = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

export const make = Effect.fn("LspConnection.make")(function* (
  options: LspConnectionOptions,
): Effect.fn.Return<LspConnection, never, Scope.Scope> {
  const scope = yield* Scope.Scope;
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const closed = yield* Deferred.make<LspConnectionClosedError>();
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;

  // `close` and `send` run for every message; the request they belong to owns the span.
  // Uninterruptible: `closed` stops the server, and with it the fiber running this close.
  const close = Effect.fnUntraced(function* (error: LspConnectionClosedError) {
    if (!(yield* Deferred.succeed(closed, error))) return;
    const waiting = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiting, ({ deferred }) => Deferred.fail(deferred, error), {
      discard: true,
    });
    yield* Queue.end(outgoing);
  }, Effect.uninterruptible);

  const send = Effect.fnUntraced(function* (message: Record<string, unknown>) {
    if (Deferred.isDoneUnsafe(closed)) return yield* Effect.flip(Deferred.await(closed));
    const accepted = yield* Queue.offer(outgoing, encodeLspMessage({ jsonrpc: "2.0", ...message }));
    if (!accepted) return yield* new LspConnectionClosedError({ reason: "ended" });
  });

  const answerRequest = (id: string | number, method: string, params: unknown) =>
    options.onRequest(method, params).pipe(
      Effect.matchCauseEffect({
        onSuccess: (result) => send({ id, result: result ?? null }),
        onFailure: () =>
          send({ id, error: { code: JSON_RPC_INTERNAL_ERROR, message: "Request failed." } }),
      }),
      Effect.ignore,
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const settle = (id: number, exit: Exit.Exit<unknown, LspError>) =>
    Effect.suspend(() => {
      const waiting = pending.get(id);
      if (waiting === undefined) return Effect.void;
      pending.delete(id);
      return Deferred.done(waiting.deferred, exit);
    });

  // Runs once a message; the request it settles owns the span.
  const route = Effect.fnUntraced(function* (message: unknown) {
    if (!isRecord(message)) return;
    const { id, method } = message;
    if (typeof method === "string") {
      if (typeof id === "string" || typeof id === "number") {
        return yield* answerRequest(id, method, message.params);
      }
      return yield* options.onNotification(method, message.params);
    }
    if (typeof id !== "number") return;
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : 0;
      const waiting = pending.get(id);
      return yield* settle(
        id,
        Exit.fail(new LspResponseError({ method: waiting?.method ?? "unknown", code })),
      );
    }
    return yield* settle(id, Exit.succeed(message.result));
  });

  const decoder = makeLspFrameDecoder();
  const framingFailure = (failure: LspFramingFailure) =>
    new LspConnectionClosedError({ reason: "framing", framing: failure });

  yield* options.input.pipe(
    Stream.runForEach((chunk) => {
      const decoded = decoder.push(chunk);
      if (decoded._tag === "failure") return Effect.fail(framingFailure(decoded.failure));
      return Effect.forEach(decoded.bodies, (body) => route(parseBody(body)), { discard: true });
    }),
    Effect.matchCauseEffect({
      onSuccess: () => close(new LspConnectionClosedError({ reason: "ended" })),
      onFailure: (cause) => {
        const failure = cause.reasons.find(Cause.isFailReason)?.error;
        return close(
          isConnectionClosed(failure)
            ? failure
            : new LspConnectionClosedError({ reason: "read_failed", cause: Cause.squash(cause) }),
        );
      },
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(options.output),
    Effect.catchCause((cause) =>
      close(new LspConnectionClosedError({ reason: "write_failed", cause: Cause.squash(cause) })),
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() => close(new LspConnectionClosedError({ reason: "ended" })));

  const request: LspConnection["request"] = Effect.fn("LspConnection.request")(
    function* (method, params) {
      yield* Effect.annotateCurrentSpan({ "rpc.system": "jsonrpc", "rpc.method": method });
      const id = nextRequestId++;
      const deferred = yield* Deferred.make<unknown, LspError>();
      pending.set(id, { method, deferred });
      return yield* send({ id, method, ...(params === undefined ? {} : { params }) }).pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.onExit((exit) => {
          pending.delete(id);
          return Exit.hasInterrupts(exit)
            ? Effect.ignore(send({ method: "$/cancelRequest", params: { id } }))
            : Effect.void;
        }),
      );
    },
  );

  return {
    request,
    notify: (method, params) => send({ method, ...(params === undefined ? {} : { params }) }),
    closed: Deferred.await(closed),
  };
});
