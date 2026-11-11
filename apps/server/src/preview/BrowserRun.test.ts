import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, SecretProviderId, type ServerSettings } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import * as ServerSettingsModule from "../serverSettings.ts";
import * as BrowserRun from "./BrowserRun.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-0123456789-abcdefghij";
const vault = {
  provider: SecretProviderId.make("vault"),
  reference: "op://Private/Cloudflare/token",
};

const withSettings = (
  browserRun: ServerSettings["browserRun"],
  status: number | null = 200,
  secret: string | undefined = TOKEN,
) => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const httpClient = HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    return status === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  const layer = BrowserRun.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(
      Layer.mock(SecretResolver.SecretResolver)({
        read: (references) => Effect.succeed(references.map(() => secret)),
        invalidate: () => Effect.void,
        label: (provider) => Effect.succeed(provider),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettingsModule.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, browserRun }),
      }),
    ),
  );
  return { requests, layer };
};

describe("BrowserRun", () => {
  it.effect(
    "offers an endpoint only while it is on with a well-formed account and a readable token",
    () =>
      Effect.gen(function* () {
        const endpointOf = (browserRun: ServerSettings["browserRun"], secret?: string) =>
          Effect.gen(function* () {
            return yield* (yield* BrowserRun.BrowserRun).endpoint;
          }).pipe(Effect.provide(withSettings(browserRun, 200, secret).layer));
        const ready = { enabled: true, accountId: ACCOUNT.toUpperCase(), apiToken: vault };
        assert.deepEqual(
          yield* endpointOf(ready, TOKEN),
          Option.some({
            url: `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser?keep_alive=120000`,
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        );
        for (const [browserRun, secret] of [
          [{ ...ready, enabled: false }, TOKEN],
          [{ ...ready, accountId: `${ACCOUNT}/../other` }, TOKEN],
          [{ ...ready, apiToken: "" }, TOKEN],
          [ready, ""],
          [ready, "token\r\nX-Injected: 1"],
        ] as const) {
          assert.deepEqual(yield* endpointOf(browserRun, secret), Option.none());
        }
      }),
  );

  it.effect("checks the saved account and token without starting a browser", () =>
    Effect.gen(function* () {
      const check = (
        browserRun: ServerSettings["browserRun"],
        status: number | null,
        secret?: string,
      ) => {
        const { layer, requests } = withSettings(browserRun, status, secret);
        return Effect.gen(function* () {
          return { result: yield* (yield* BrowserRun.BrowserRun).check, requests };
        }).pipe(Effect.provide(layer));
      };
      // Off still checks, so the credentials can be tried before they are used.
      const saved = { enabled: false, accountId: ACCOUNT, apiToken: TOKEN };
      const accepted = yield* check(saved, 200);
      assert.deepEqual(accepted.result, { _tag: "Accepted" });
      assert.deepEqual(accepted.requests, [
        {
          url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/session`,
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
      assert.deepEqual((yield* check(saved, 401)).result, { _tag: "Rejected", status: 401 });
      assert.deepEqual((yield* check(saved, null)).result, { _tag: "Unreachable" });
      const unset = yield* check({ ...saved, accountId: "" }, 200);
      assert.deepEqual(unset, { result: { _tag: "NotConfigured" }, requests: [] });
      const locked = yield* check({ ...saved, apiToken: vault }, 200, "");
      assert.deepEqual(locked, { result: { _tag: "TokenUnreadable" }, requests: [] });
    }),
  );

  it("sends only public http pages to Browser Run", async () => {
    const reached = await Promise.all(
      [
        "https://93.184.216.34/docs",
        "http://127.0.0.1:5173/",
        "http://[::1]:3000/",
        "http://192.168.1.10/",
        "http://100.67.174.29/",
        "file:///etc/hosts",
        "about:blank",
      ].map(BrowserRun.reaches),
    );
    assert.deepEqual(reached, [true, false, false, false, false, false, false]);
  });

  it("reports a failed connection without the account in its URL", () => {
    const failure = BrowserRun.connectFailure(
      new Error(
        `browserType.connectOverCDP: WebSocket error: wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser 401 Unauthorized`,
      ),
    );
    assert.equal(failure, "Cloudflare answered 401");
    assert.equal(
      BrowserRun.connectFailure(new Error("browserType.connectOverCDP: Timeout 10000ms exceeded.")),
      "the connection timed out",
    );
  });
});
