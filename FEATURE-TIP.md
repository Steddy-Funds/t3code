# Feature tip

`akiva/feature-tip` is the fork's `main` plus the features Akiva wants to keep.
`main` stays a plain mirror of pingdotgg/t3code. The tip itself never goes
upstream; a feature can, from its own branch, when Akiva decides.

## Included

| Feature                                                             | PR  | Merge   |
| ------------------------------------------------------------------- | --- | ------- |
| Two-finger swipe to reply                                           | #39 | e920434 |
| Cmd/Option section reply (built on #39)                             | #40 | 7b822bb |
| Cmd+swipe to one bullet, Cmd-only sections, composer blank-line fix | #41 | 44c451d |
| A highlighted bullet keeps its marker in place                      | #42 | 727e87c |
| Cmd+swipe replies to one image                                      | #43 | 3d319a8 |
| Cmd+swipe a sidebar thread to mention it                            | #44 | 336207d |
| A swipe replies to a section by default, with a setting             | #45 | 615ed49 |
| A swipe beside a message's sections replies to the nearest one      | #46 | 947cea5 |
| Cmd+Shift+Enter docks the composer as a full-height editor          | #47 | 0940962 |
| PR review sidebar section; Awaiting children in lineage             | #49 | 7bf63d6 |
| Sidebar names what a waiting thread waits on (agents, PR)           | #50 | 627adaf |
| Background threads: Backgrounded section, thread menu and MCP       | #51 | b610ba6 |
| Appearance > Sidebar details: hide branch and model                 | #52 | fd65dd9 |
| Sidebar counts every live agent in a thread's tree, badge at 2+     | #53 | 36a450e |
| Sidebar cards fit in two rows without the branch                    | #54 | ab7770f |
| Agent badge hover shows the lineage tree; owner only for forks      | #55 | 699d8da |
| Thread details: cost, tokens and activity for thread and lineage    | #56 | 1e9ea81 |
| Lineage tree rows open their thread; card hover shows the branch    | #57 | 958cfe7 |
| Sidebar machine toggle; machine in thread header; copy branch       | #58 | 796dfab |
| Sidebar cards drop the empty icon group's gap                       | #59 | 3f45500 |
| Thread cost and activity on one line, labels on hover | #60 | 4f50cad |
| Machines show stress: sweating icon, hover card, mobile sheet (node resources 1/5) | #61 | 6612446 |
| Task manager, cross-machine view, NVIDIA and Intel GPUs (node resources 2/5) | #62 | 4c28c14 |

Held: #38 (pods notes in the t3-orchestration skill). It edits
`.agents/skills/t3-orchestration/`, which exists only on
`orchestration-extension`. It comes in with that skill, if the skill is ported.

## Server tip

`akiva/server-tip` is `main` plus only the features above that change the
server, so the servers (orch-t3 on the Linux host) run fewer, steadier changes.
The Mac runs this tip, which already has them all.

- #51 Background threads (MCP tools)
- #56 Thread usage RPC (`server.getThreadUsage`)
- #61 Machine verdict (`subscribeMachine`, `subscribeMachineProcesses`): server half only, since the branch stacks on this tip
- #62 Native monitor v4, GPUs, host processes, history, kill: server half only (`eba584d`), plus the client-runtime frame folder its test reads

A feature that changes `apps/server`, or a contract the server reads, is
merged there too: its branch head with `--no-ff`, never this tip.
Client-settings fields are frontend.

## Adding a feature

1. Branch from `main`, so the feature stays separate. Branch from
   `akiva/feature-tip` only when it builds on a tip feature.
2. Open the PR against `akiva/feature-tip`. Never against upstream.
3. Merge it with a merge commit (not a squash), so each feature stays one
   traceable merge. Add a row to the table above.
4. A server feature also merges into `akiva/server-tip` (Server tip).

## Syncing with upstream

1. Sync the fork's `main` from pingdotgg/t3code (fast-forward only).
2. Merge `main` into `akiva/feature-tip` and `akiva/server-tip`, and fix any
   conflicts in the merge commit. If a feature has landed upstream, revert its merge here and drop
   its row.
3. Run typecheck and the web unit tests before pushing the tip.
