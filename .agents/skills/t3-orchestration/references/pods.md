# Pods

## Containerised pods

Pods are orch's (`orch pod`, docs/pods.md in the agentic repo): Docker only. A pod is an agent container `<pod>` plus a Docker-in-Docker sidecar `<pod>-dind` running the worktree's `docker compose` stack, on one host worktree and branch mounted into both at the same path. No T3 server and no provider session runs in a pod: T3's own pod runtime (a project's `pod` block, `runsIn`) is not used for now. The threads that work on a pod (lanes; the broker here) are ordinary host threads bound to the pod's worktree, and many may attach to one pod.

- **Find first.** Before you build, run, test or debug a feature, `orch pod find <words>`: each match's card has what the pod focuses on, its slice (thread link), branch, worktree, the threads attached with their notes, its URLs (`https://<pod>-<service>.pods.internal`), the attach line and the container preamble. `orch pod show <pod>`, `orch pod list --json`.
- **Attach.** `orch pod attach <pod> --note "<what you are doing>" --bind` records you on the pod, subscribes you to its `pod:<pod>` events (`orch notify`), and rebinds your thread to the pod's worktree when you are elsewhere in the same project (your session restarts there: make it the last action of your turn). From another project, launch a thread on the pod with the `t3_thread_launch` fields it prints (`existing_worktree`). `orch pod detach <pod>` when done.
- **Work inside the containers.** Edit files at the worktree path on the host and run git on the host only; everything else goes through `docker exec`:

  ```
  P=<pod>; W=<worktree>            # host path == container path (or $ORCH_POD, $ORCH_POD_WORKTREE)
  px() { docker exec -u "$(id -u):$(id -g)" -w "$W" "$P" "$@"; }   # agent container: installs, lint, scripts
  dc() { px docker compose "$@"; }                                 # compose stack: tests, migrations, logs, db
  ```

  `px npm --prefix frontend ci`, `px ruff check backend/`, `dc exec -T backend python manage.py test <ids> --parallel 2`, `dc logs --tail 100 backend`. `<pod>-dind` directly only for daemon trouble. Never git inside a container (the worktree shares the source `.git`), never project commands on the host (its `docker` is the host daemon), never a bare `dc up -d` (use the recreate `orch pod reload --apply` prints).
- The slice brings a pod up with `orch pod up <pod> --repo <name> --ref <slice branch> --about "<features>"`; the ready mail carries the lane launch fields. The pod's `.env` is templated and never committed.
- A pod runs with model, paid-provider and messaging keys blank or on fake backends unless Akiva approved real ones for that pod. Never print a key's value; check names only.
- **Signing in (steddyfunds.ai).** Every pod's Sign In page has a Dev Login tab with one-click accounts for the seeded users, labelled by role (Admin, Broker; `VITE_DEV_LOGIN_ACCOUNTS` in the pod's environment). Browser checks sign in there by label; agents never type credentials by hand, call auth APIs, mint tokens or edit rows to forge or bypass a session. Playwright e2e tests sign in through `frontend/e2e/helpers/login.ts`, which types the seeded `REACT_APP_*` credentials. A pod that needs another role (underwriter, admin support) adds a local test user for that pod only: create it (`dc exec backend python manage.py shell` with `User.objects.create_user(email=..., password=..., role=...)`, or extend `seed_test_users` on the pod branch if the feature needs it), append its entry to `VITE_DEV_LOGIN_ACCOUNTS` in the pod's own `.env` (never committed) and recreate the frontend (`dc up -d --no-deps frontend`). A Playwright spec that signs in as that role reads its `REACT_APP_<ROLE>_EMAIL` and `_PASSWORD` from the same `.env`. The variable is local dev only: never set it for a staging or production build or service.

## Production access

Production is read-only for every agent: database queries inside a transaction-scoped `SET TRANSACTION READ ONLY` (check `SHOW transaction_read_only`; never a session-level SET, see pgbouncer below), logs, and GET-only APIs. The steddyfunds.ai database is Railway project brave-warmth, environment production, service Postgres, reached with `railway ssh --project <id> --environment production --service Postgres` (explicit flags matter outside a linked directory, and names may be refused). Railway has no read-only token, so read-only is by convention, not by credential: read-only transactions, and only read-only MCP tools and queries.

**Never make a shared production connection read-only (pgbouncer).** Production apps reach Postgres through pgbouncer in transaction pooling mode with no reset query, so a session-level setting sticks to a pooled server connection and is handed to app traffic.

1. Never run `SET default_transaction_read_only = on`, `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` or any other plain `SET` (statement_timeout, search_path, ...) from a production Django shell or any client on the app `DATABASE_URL` (pgbouncer.railway.internal).
2. Read-only research: psql straight on the Postgres service (`railway ssh ... --service Postgres`, `psql "$DATABASE_URL"`), each query in `BEGIN; SET TRANSACTION READ ONLY; ... ROLLBACK`; in a Django shell, scope it to one transaction: `with transaction.atomic(): cursor.execute("SET TRANSACTION READ ONLY")` (or `SET LOCAL`).
3. No `.iterator()` or server-side cursors through pgbouncer ("cursor does not exist").
4. Briefs and research templates say this, never "every session read-only".

Why: on 2026-10-22 a research cell ran `SET default_transaction_read_only = on` in Django shells over railway ssh. Two pooled connections went read-only for ~47 min: ~120 API 500s, failed email-intake steps and lookups, and the LLM runner crashed. It cleared only when pgbouncer retired the connections.

The one exception is a BugBot one-off fix, approved by the authorized person and run once through the approval flow, with an audit record. No other agent writes to production, and no agent runs a fix script any other way. That flow is not ported to T3 yet ([Not ported yet](../SKILL.md#not-ported-yet)).
