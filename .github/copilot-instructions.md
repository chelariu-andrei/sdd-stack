# Team workflow (always applies)

This repository uses **spec-driven development delivered as GitHub stacked PRs**.
Before brainstorming, branching, committing or opening a PR, load the `sdd-stacked-prs` skill and follow it.

- The bottom PR of every stack is the spec (`<feature>/spec`); nothing else is built until it is approved.
- Implementation comes in small layers (`<feature>/impl-<n>-<slug>`), optional test layers (`<feature>/tests-<n>-<slug>`).
- Use `gh stack` for branches and PRs. Never `gh pr create`, never push to `main`, never merge or approve PRs yourself.
- A Copilot hook and the required `sdd-stack` CI check enforce this. When a tool call is denied, follow the reason instead of working around it.
- Superpowers skills are used inside this workflow (brainstorming → writing-plans → TDD / subagent-driven-development).
  User preferences for superpowers in this repo: design docs and plans go on the `<feature>/spec` layer; worktrees use the
  layer branch name; after writing-plans, submit the spec PR and stop; the only way to finish a branch is `gh stack submit`.
  See the "Running superpowers inside this workflow" table in the `sdd-stacked-prs` skill.
