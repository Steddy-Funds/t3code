# Feature tip

`akiva/feature-tip` is the fork's `main` plus the features Akiva wants to keep.
`main` stays a plain mirror of pingdotgg/t3code. The tip itself never goes
upstream; a feature can, from its own branch, when Akiva decides.

## Included

| Feature                                                                                                                                       | PR  | Merge   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------- |
| Two-finger swipe to reply                                                                                                                     | #39 | e920434 |
| Cmd/Option section reply (built on #39)                                                                                                       | #40 | 7b822bb |
| Cmd+swipe to one bullet, Cmd-only sections, composer blank-line fix                                                                           | #41 | 44c451d |
| A highlighted bullet keeps its marker in place                                                                                                | #42 | 727e87c |
| Cmd+swipe replies to one image                                                                                                                | #43 | 3d319a8 |
| Cmd+swipe a sidebar thread to mention it                                                                                                      | #44 | 336207d |
| A swipe replies to a section by default, with a setting                                                                                       | #45 | 615ed49 |
| A swipe beside a message's sections replies to the nearest one                                                                                | #46 | 947cea5 |
| Cmd+Shift+Enter docks the composer as a full-height editor                                                                                    | #47 | 0940962 |
| PR review sidebar section; Awaiting children in lineage                                                                                       | #49 | 7bf63d6 |
| Sidebar names what a waiting thread waits on (agents, PR)                                                                                     | #50 | 627adaf |
| Background threads: Backgrounded section, thread menu and MCP                                                                                 | #51 | b610ba6 |
| Appearance > Sidebar details: hide branch and model                                                                                           | #52 | fd65dd9 |
| Sidebar counts every live agent in a thread's tree, badge at 2+                                                                               | #53 | 36a450e |
| Sidebar cards fit in two rows without the branch                                                                                              | #54 | ab7770f |
| Agent badge hover shows the lineage tree; owner only for forks                                                                                | #55 | 699d8da |
| Thread details: cost, tokens and activity for thread and lineage                                                                              | #56 | 1e9ea81 |
| Lineage tree rows open their thread; card hover shows the branch                                                                              | #57 | 958cfe7 |
| Sidebar machine toggle; machine in thread header; copy branch                                                                                 | #58 | 796dfab |
| Sidebar cards drop the empty icon group's gap                                                                                                 | #59 | 3f45500 |
| Thread cost and activity on one line, labels on hover                                                                                         | #60 | 4f50cad |
| Machines show stress: sweating icon, hover card, mobile sheet (node resources 1/5)                                                            | #61 | 6612446 |
| Task manager, cross-machine view, NVIDIA and Intel GPUs (node resources 2/5)                                                                  | #62 | 4c28c14 |
| Who is using a machine: ownership, claims, buckets, per-thread resources (node resources 3/5)                                                 | #63 | 3180ffa |
| Agents read machine load, load-triggered scheduled tasks, background auto-buckets, inline machine card (node resources 4/5)                   | #64 | 8c11592 |
| Load management: guarded runs, auto-pause of low-priority agents and their containers, thread priorities; off by default (node resources 5/5) | #65 | 59cd8f9 |
| Thread cost as one lineage total, last pull cached                                                                                            | #66 | 6a6c02a |
| Thread cost in three digits with K and M; turns as an icon                                                                                    | #67 | 6023b1b |
| Thread resources cover subagents; `-` for unmeasured; thread details opens a focused machine tab (node resources 6)                           | #68 | 04bf4fe |
| Gamba mode: a Mario Party DS coin each time an agent turn finishes, subagents included (Labs)                                                 | #69 | 2958408 |
| Gamba mode volume (Labs), and a de-hissed, softened coin                                                                                      | #70 | d710e1b |
| Agents share a server they started at a tailnet or public URL, pinned to its PIDs, with Stop in thread details                                | #72 | 05ddecc |
| Per-thread Autonomy flag (experimental) in Thread details → Flags; children inherit it                                                        | #71 | 98eee31 |
| Agent browser tabs on Cloudflare Browser Run: public pages off the host's Chrome; Settings → Browser, off by default                          | #74 | f84a989 |
| Agent messages queued behind one another on a busy thread start in one turn, each its own message                                             | #73 | 364f161 |
| Claude auto-compact window per thread, in the model picker and from `delegate_task` and `t3_thread_launch` (`autoCompactWindow`)              | #75 | cabfbbb |
| Sidebar token burn rate (tokens per minute over 5 minutes, agents included) beside the bot count; the Working shelf sorts by it               | #76 | f813ada |
| Review comments in the diff and the file viewer: Send straight to the agent, Send N, quoted selection                                         | #78 | d4019f5 |
| JetBrains code keys (Cmd+B, Cmd+O, F7, Alt+F7…) scoped to code, diff and project-tree focus; existing installs migrate                        | #77 | b48cc35 |
| Material Ocean theme (Settings → Appearance): Material Oceanic chrome; Deep Ocean code, terminal, diffs and syntax colours                    | #81 | 5f49f37 |
| Hold Cmd on a thread for a quick reference of the shortcuts that work where focus is (Settings → Keybindings to turn off)                     | #79 | 613681d |
| Code intelligence server: ty and `tsc --lsp` answer typed, read-only `codeIntel.*` RPCs (hover, definition, symbols); no UI yet               | #80 | 401fbc8 |
| Agent review notes: the agent flags lines for your review (`flag_for_review`); a timeline card and an in-diff note with Reply (Labs)          | #83 | 64d7d75 |

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
- #63 Ownership, claims, buckets, per-thread resources, MCP tools: server half only (`8256ecc`), with the provider packages' spawn sites
- #64 `t3_machine_read`, load trigger, auto-buckets built-in: server half only (`8177ce2`)
- #65 Load guard (`t3 guard`), load pause with docker pause and startup reconcile, priorities: server half only (`6ea90d5`), with the provider packages' guard env injection
- #68 Thread resources cover the subagent lineage: server half only (`680f646`)
- #69 Gamba mode's `nativeSubagentsCompleted` thread shell count (whole branch; the client half is inert on a server)
- #74 Cloudflare Browser Run for the server browser (`server.checkBrowserRun`, `browserRun` settings): the whole branch, which starts from `main`
- #73 Queued agent messages start in one turn (`mergedIntoRunId` on a run, followed by `t3_thread_wait`): the whole branch, which starts from `main`
- #75 Per-thread auto-compact window (the `autoCompactWindow` model option on Claude): the whole branch, which starts from `main`
- #76 Token burn rates (`subscribeTokenBurnRates`): server half only (`99713e8`)
- #77 JetBrains keymap (new default keys, `keybindings.json` migration, Reset to default placement): the whole branch, which starts from `main`
- #80 Code intelligence (`codeIntel.*` RPCs, ty and `tsc --lsp` by the `typescript-lsp` alias, `codeIntel.enabled` off switch): the whole branch, which starts from `main`
- #83 Agent review notes (`flag_for_review` MCP tool, `review_note.record`, `agentReviewNotesEnabled`): server half only (`fbdb8e8`, 4 picks), since the branch also carries #78

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
