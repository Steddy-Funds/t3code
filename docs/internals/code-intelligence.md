# Code intelligence

The server runs language servers beside a project's files and answers typed, read-only
`codeIntel.*` RPCs for navigation, symbols, and semantic tokens. This page holds the constraints
that are not visible from one file. The code is in
[`apps/server/src/codeIntel`](../../apps/server/src/codeIntel).

## Why filesystem read is the right scope

Every `codeIntel` read requires only the scope `projects.readFile` requires. That is correct
because of two rules, and stops being correct the moment either is relaxed:

- **Nothing that lives in a workspace is executed.** The Python environment is found by reading
  `pyvenv.cfg`, `pyrightconfig.json`, `pyproject.toml`, and the worktree's `.git` pointer; no
  interpreter and no `git` process runs. TypeScript is always the server's own `typescript`
  package, never a project's `node_modules/typescript`. Automatic type acquisition, which installs
  packages from npm, is answered off. A language server that can only work by running a project's
  interpreter does not fit here: starting one would need `terminal:operate`.
- **Nothing a client sends reaches a language server.** A request names a file and a position. The
  text the server analyses is read from disk through
  [`WorkspaceFileSystem`](../../apps/server/src/workspace/WorkspaceFileSystem.ts), under the same
  path rule as a file read, so a client that may read files learns nothing it could not read.

`codeIntel.installServer` downloads a binary, so it is client-guarded behind settings write. It is
the only code path that reaches the network, and the release it fetches is pinned and checked
against a sha256 in the server's own table.

## Revisions instead of shared buffers

Two clients, or a client and an agent, must not give a server different contents for one file. So
the file on disk is the only truth: each request reads it, syncs the server when its text changed,
and answers with the `revision` it was computed against. A client applies an answer only to text
of that revision, and may send `ifRevision` to have a changed file refused as `stale_document`
before anything starts. An unsaved buffer or an old diff pane therefore gets no answer rather than
a wrong one.

## Traps

- **Position encoding.** Both servers choose UTF-8 when it is offered, and client offsets are
  UTF-16. Only UTF-16 is offered; a server that insists on another encoding fails to start.
- **A replaced file is `changed`, not `created`.** Neither server watches files, so the service
  watches for them. An atomic save (write a temporary file, rename it over the original) arrives
  from the OS as a new entry. TypeScript told "created" about a file it already knows keeps the old
  text. The watcher remembers the paths it has seen to tell the two apart.
- **An open document hides the disk.** A document the service opened for one request shadows later
  edits on disk. On a watcher event it is closed, which makes the disk the truth again.
- **Empty answers while loading.** A server answers `[]` while it loads a project. An empty answer
  given while the server reports progress is asked again within the request's deadline; a slow
  server during that time does not count toward the three timeouts that restart it.
- **Watch cost.** Linux needs one inotify watch a directory, from a per-user budget every process
  shares. The watcher skips dependency and build directories, gives up past 8,192 directories, and
  then checks only the files an answer points at. Third-party changes are picked up from the
  manifests that signal them (`package.json`, `pyproject.toml`, `pyvenv.cfg`, lockfiles), by
  restarting that root's server.

## Limits that differ by platform

A language server must never take memory from a provider turn. On Linux each one runs in its own
systemd scope with a memory maximum and a higher OOM score than agents, so the kernel kills it
first and alone. Elsewhere there are no scopes: TypeScript's Go runtime gets a soft heap limit
(`GOMEMLIMIT`), and ty has no such flag. On every platform a server is given this process's PID
and exits when it is gone, runs in its own process group, and is killed after a bounded grace.
