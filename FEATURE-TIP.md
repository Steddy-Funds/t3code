# Feature tip

`akiva/feature-tip` is the fork's `main` plus the features Akiva wants to keep.
`main` stays a plain mirror of pingdotgg/t3code. Nothing on this branch goes
upstream.

## Included

| Feature                                                             | PR  | Merge   |
| ------------------------------------------------------------------- | --- | ------- |
| Two-finger swipe to reply                                           | #39 | e920434 |
| Cmd/Option section reply (built on #39)                             | #40 | 7b822bb |
| Cmd+swipe to one bullet, Cmd-only sections, composer blank-line fix | #41 | 44c451d |
| A highlighted bullet keeps its marker in place                      | #42 | 727e87c |
| Cmd+swipe replies to one image                                      | #43 | 3d319a8 |

Held: #38 (pods notes in the t3-orchestration skill). It edits
`.agents/skills/t3-orchestration/`, which exists only on
`orchestration-extension`. It comes in with that skill, if the skill is ported.

## Adding a feature

1. Branch from `akiva/feature-tip`, or from `main` if the feature is independent.
2. Open the PR against `akiva/feature-tip`. Never against upstream.
3. Merge it with a merge commit (not a squash), so each feature stays one
   traceable merge. Add a row to the table above.

## Syncing with upstream

1. Sync the fork's `main` from pingdotgg/t3code (fast-forward only).
2. Merge `main` into `akiva/feature-tip` and fix any conflicts in the merge
   commit. If a feature has landed upstream, revert its merge here and drop
   its row.
3. Run typecheck and the web unit tests before pushing the tip.
