---
name: sdd-stacked-prs
description: Mandatory delivery workflow for this repo. Use for ANY feature, bugfix or refactor that changes code - spec-driven development delivered as a GitHub stacked PR (spec layer first, reviewed and approved, then small implementation layers and optional test layers). Use whenever you are about to brainstorm, write a spec or plan, create a branch, commit, push or open a pull request.
---

# SDD with stacked pull requests

Every change ships as one **GitHub stack** (`gh stack`), bottom to top:

```
main
 └─ <feature>/spec              ← spec + plan only. Must be APPROVED before anything above exists.
     └─ <feature>/impl-1-<slug> ← ≤ 400 changed lines, one logical step, tests for that step included (TDD)
         └─ <feature>/impl-2-<slug>
             └─ <feature>/tests-1-<slug>   ← optional: integration / e2e tests only
```

Rules are enforced by a Copilot hook (`.github/hooks/sdd-stack.json`) and by the required CI
status `sdd-stack`. Limits and paths live in `.github/sdd-stack.json` — read it if you need the exact values.
If the hook denies a tool call, do NOT look for a workaround: follow the reason it gives.

## Phase 1 — Spec (one PR)

1. Run the superpowers **brainstorming** skill with the user. Save the design where it already saves it
   (`docs/superpowers/specs/…`) or in `specs/<feature>/spec.md`.
2. Run superpowers **writing-plans**. The plan goes in the spec layer too, so reviewers approve *what* and *how* together.
   In the plan, group tasks into **layers**: each layer = one future `impl-<n>` PR, ≤ 400 lines, independently reviewable,
   leaves the build green. Mark which tasks (if any) become a separate `tests-<n>` layer.
3. Create the stack and publish only the spec layer:
   ```bash
   gh stack init <feature>/spec     # feature = short kebab-case name, e.g. invoice-export
   git add docs/ specs/ && git commit -m "spec(<feature>): design and plan"
   gh stack push && gh stack submit
   ```
   PR title: `spec(<feature>): <summary>`. The body links the plan and lists the planned layers.
4. **STOP.** Tell the user the spec PR URL and that implementation starts after approval.
   Do not create impl branches, edit code, or "prepare" anything while waiting.
   If reviewers request changes, update the spec layer (`gh stack checkout <feature>/spec`), push, and wait again.

## Phase 2 — Implementation (one PR per layer)

Only after the spec PR is approved (the hook checks this through `gh`):

```bash
gh stack checkout <feature>/spec      # or the top of the stack
gh stack add <feature>/impl-1-<slug>
# implement the tasks of layer 1 with superpowers test-driven-development / subagent-driven-development
git commit ...
gh stack add <feature>/impl-2-<slug>
...
gh stack push && gh stack submit      # one PR per layer, already linked as a stack
```

- One layer = the tasks the plan assigned to it. If a layer grows past the limit, the commit is rejected: stop and `gh stack add` a new layer.
- Implementation layers never edit spec files. If the spec turns out wrong, stop, explain, and update the spec layer for re-approval.
- Ticking checkboxes in the plan (`docs/superpowers/plans/**`) from impl layers is allowed.
- Feedback on a lower layer: `gh stack checkout <layer>`, fix, commit, `gh stack rebase --upstack`, `gh stack push`.
- After lower layers merge: `gh stack sync`.

## Tests layers

TDD stays the default: unit tests live in the same impl layer as the code they cover.
Use a separate `<feature>/tests-<n>-<slug>` layer only for integration / e2e / contract suites that the plan
called out. A tests layer may only touch test paths.

## Running superpowers inside this workflow

Superpowers skills stay in charge of *how* you think and build; this skill decides *where* the work lands.
Where they disagree, this skill wins:

| Superpowers step | What to do here |
|---|---|
| brainstorming → "commit the design doc" | Before that commit run `gh stack init <feature>/spec`. Committing on `main` is blocked. The in-chat design approval stays; the spec PR approval by the team comes on top of it. |
| using-git-worktrees | One worktree per feature, created on branch `<feature>/spec` (`git worktree add .worktrees/<feature> -b <feature>/spec`). Run every `gh stack` command inside that worktree. Any other branch name is rejected at commit. |
| writing-plans | Put the plan in the spec layer. Group tasks under `## Layer impl-1-<slug>` / `## Layer tests-1-<slug>` headings, each ≤ the line limit. Then commit, `gh stack submit`, and **stop** — do not offer the execution handoff until the spec PR is approved. |
| subagent-driven-development / executing-plans | Only after approval. The **controller** (not the implementer subagents) runs `gh stack add <feature>/<layer>` before dispatching the first task of each `## Layer` section. Implementers only edit, test and commit. If a commit is denied for size, that is not a broken plan: the controller adds the next layer and continues. |
| final review → "delete the workspace" | Run `gh stack push && gh stack submit` first, then remove the worktree. |
| finishing-a-development-branch | Ignore its menu. The only finish is `gh stack submit` (local merge to `main` and `gh pr create` are blocked). |

## Never

- commit or push to `main`/`master`, `git push --force` (use `gh stack push`)
- `gh pr create` (use `gh stack submit`), `gh pr merge`, `gh stack merge`, `gh pr review --approve`
- superpowers **finishing-a-development-branch** merge/PR options — replace that step with `gh stack submit`
- mix spec and code in the same layer

## Setup check

If `gh stack` is missing: `gh extension install github/gh-stack` (needs gh ≥ 2.90). Optional companion skill: `gh skill install github/gh-stack`.
