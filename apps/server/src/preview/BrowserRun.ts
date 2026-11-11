import type { BrowserRunCheckResult } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import { resolvesPublicly } from "../htmlRender/publicProxy.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";

const API = "api.cloudflare.com/client/v4/accounts";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// Only what may go in a header: no space, CR or LF.
const API_TOKEN = /^[A-Za-z0-9._~+/=-]{20,512}$/;
const CHECK_TIMEOUT = "5 seconds";

/** Browser Run ends a browser that gets no CDP command for this long, so a crashed server stops paying. */
const KEEP_ALIVE_MS = 120_000;
/** Commands this often keep the browser through a few missed beats on a loaded host. */
export const HEARTBEAT_MS = 30_000;

/** Browser Run's Chrome, whatever the server runs on. */
export const HOST = { platform: "linux", arch: "x64", release: "" } as const;

export interface BrowserRunEndpoint {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export class BrowserRun extends Context.Service<
  BrowserRun,
  {
    /** Where to connect a browser; none while Browser Run is off, incomplete, or its token cannot be read. */
    readonly endpoint: Effect.Effect<Option.Option<BrowserRunEndpoint>>;
    /** Asks Cloudflare whether it takes the saved account and token, on or off. Starts no browser. */
    readonly check: Effect.Effect<BrowserRunCheckResult>;
  }
>()("t3/preview/BrowserRun") {}

/**
 * Whether Browser Run can load `url`: http(s) to a host that resolves, from this machine, to public
 * addresses only. It refuses loopback and private addresses, and cannot see this machine's DNS.
 */
export const reaches = async (value: string) => {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
  return resolvesPublicly(url.hostname.replace(/^\[|\]$/g, ""));
};

/** Why a connection failed, without the error's text: that names the account in its URL. */
export const connectFailure = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = / (\d{3}) [A-Z]/.exec(message)?.[1];
  if (status) return `Cloudflare answered ${status}`;
  return /timeout/i.test(message) ? "the connection timed out" : "the connection failed";
};

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const httpClient = yield* HttpClient.HttpClient;

  const credentials = Effect.fn("BrowserRun.credentials")(function* (refresh: boolean) {
    const saved = yield* settings.getSettings.pipe(
      Effect.map(({ browserRun }) => browserRun),
      Effect.option,
    );
    if (Option.isNone(saved)) return { _tag: "NotConfigured" } as const;
    const { enabled, apiToken } = saved.value;
    const accountId = saved.value.accountId.toLowerCase();
    if (!ACCOUNT_ID.test(accountId) || apiToken === "") return { _tag: "NotConfigured" } as const;
    // A vault that locked since the last read must not pass for a working token.
    if (refresh && typeof apiToken !== "string") yield* resolver.invalidate([apiToken]);
    const token = yield* requireSettingsSecret(resolver, apiToken).pipe(Effect.option);
    if (Option.isNone(token)) return { _tag: "TokenUnreadable" } as const;
    if (!API_TOKEN.test(token.value)) return { _tag: "NotConfigured" } as const;
    return {
      _tag: "Ready",
      enabled,
      accountId,
      headers: { Authorization: `Bearer ${token.value}` },
    } as const;
  });

  const endpoint = credentials(false).pipe(
    Effect.map((current) =>
      current._tag === "Ready" && current.enabled
        ? Option.some({
            url: `wss://${API}/${current.accountId}/browser-run/devtools/browser?keep_alive=${KEEP_ALIVE_MS}`,
            headers: current.headers,
          })
        : Option.none(),
    ),
  );

  const check = Effect.gen(function* () {
    const current = yield* credentials(true);
    if (current._tag !== "Ready") return { _tag: current._tag } as const;
    // Listing sessions takes the token and starts no browser. Tracing is off to keep the account and token out of spans.
    const status = yield* HttpClient.withScope(httpClient)
      .get(`https://${API}/${current.accountId}/browser-run/devtools/session`, {
        headers: current.headers,
      })
      .pipe(
        Effect.map((response) => response.status),
        Effect.scoped,
        Effect.withTracerEnabled(false),
        Effect.timeoutOption(CHECK_TIMEOUT),
        Effect.option,
        Effect.map(Option.flatten),
      );
    if (Option.isNone(status)) return { _tag: "Unreachable" } as const;
    return status.value >= 200 && status.value < 300
      ? ({ _tag: "Accepted" } as const)
      : ({ _tag: "Rejected", status: status.value } as const);
  }).pipe(Effect.withSpan("BrowserRun.check"));

  return BrowserRun.of({ endpoint, check });
});

export const layer = Layer.effect(BrowserRun, make);
