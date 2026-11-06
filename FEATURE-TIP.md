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

Held: #38 (pods notes in the t3-orchestration skill). It edits
`.agents/skills/t3-orchestration/`, which exists only on
`orchestration-extension`. It comes in with that skill, if the skill is ported.

## Adding a feature

1. Branch from `main`, so the feature stays separate. Branch from
   `akiva/feature-tip` only when it builds on a tip feature.
2. Open the PR against `akiva/feature-tip`. Never against upstream.
3. Merge it with a merge commit (not a squash), so each feature stays one
   traceable merge. Add a row to the table above.

## Syncing with upstream

1. Sync the fork's `main` from pingdotgg/t3code (fast-forward only).
2. Merge `main` into `akiva/feature-tip` and fix any conflicts in the merge
   commit. If a feature has landed upstream, revert its merge here and drop
   its row.
3. Run typecheck and the web unit tests before pushing the tip.
