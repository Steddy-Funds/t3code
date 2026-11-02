# Browser pool on Railway (stubbed)

The `browsers` service in `brave-warmth` / `QA Bot` is off. It runs a stub,
[`stub.mjs`](stub.mjs): a Node HTTP server with no dependencies that answers
`200` on `/healthz` and `/health` and `503` on every other request, WebSocket
upgrades included, on `$PORT` (3000) and `$CDP_PORT` (9222). It is not a
tailnet node.

|          |                                                                   |
| -------- | ----------------------------------------------------------------- |
| Service  | `browsers`, private host `browsers.railway.internal`              |
| Image    | `node:26.12.1-bookworm-slim`, `stub.mjs` only                     |
| Replicas | 1, the smallest CPU and memory limits, restart always, `/healthz` |

The service, its variables and the `AI Agent Host` reference variables
(`BROWSERS_WS_URL`, `BROWSERS_CDP_URL`) stay in place, so clients that read
them fail fast with `503` instead of hanging, and bringing the pool back needs
no change on `AI Agent Host`. The tailnet variables (`TS_AUTHKEY`,
`PODS_HOST_IP`, `PODS_CA_PEM`) are unused while the stub runs.

## Bringing the browsers back

The last pool is commit `0816a49a37` on `pod/ste-545-t3-hosted`: headless
Chromium on `mcr.microsoft.com/playwright:v1.60.0-noble`, a token-checking
front, a shared CDP browser, optional tailnet and pods proxy, and their tests.
Its README there documents connecting, the tailnet ACL and sizing.

1. Restore the directory and commit it:
   `git checkout 0816a49a37 -- deploy/railway/browsers && git rm deploy/railway/browsers/stub.mjs`.
   If the repo's Playwright version moved on, bump the image tag and the
   `playwright` version in its `Dockerfile` to match.
2. Restore the service settings: 2 replicas in `us-west2`, 4 GB memory and
   2 vCPU per replica, restart always, healthcheck `/healthz` (timeout 120 s).
   The replica count lives in `multiRegionConfig`:

   ```bash
   railway api 'mutation($c: JSON!) { serviceInstanceUpdate(
     serviceId: "2025c4bc-03f5-401c-baed-2153048146eb",
     environmentId: "911f4fa2-ae51-4ea3-8f14-09bf2c27d5aa",
     input: { multiRegionConfig: $c }) }' \
     --variables '{"c": {"us-west2": {"numReplicas": 2}}}'
   ```

   Set the limits in **Settings → Resources**.

3. For the tailnet, set `TS_AUTHKEY` (reusable, ephemeral, tagged
   `tag:railway-browser`, sealed), `PODS_HOST_IP` and `PODS_CA_PEM`.
   `BROWSERS_TOKEN`, `MAX_SESSIONS` and `IDLE_TIMEOUT_SECONDS` are still set.
4. Push. The service builds from this directory on the branch `AI Agent Host`
   builds from; the watch pattern limits it to changes here.
