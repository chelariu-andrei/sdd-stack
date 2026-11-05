# SDD + Stacked PRs pentru GitHub Copilot (cu superpowers)

Fluxul impus fiecărei schimbări:

```
main
 └─ <feature>/spec               PR 1: spec + plan (superpowers brainstorming + writing-plans) → APPROVE
     └─ <feature>/impl-1-<slug>  PR 2: ≤ 400 linii, un pas logic, cu testele lui unitare (TDD)
         └─ <feature>/impl-2-<slug>
             └─ <feature>/tests-1-<slug>   opțional: doar teste de integrare / e2e
```

Stack-ul folosește stacked PRs native GitHub (`gh stack`, public preview din iulie 2026).

## Ce conține

| Fișier | Rol |
|---|---|
| `.github/sdd-stack.json` | Politica: tipare de branch, căi pentru spec/teste, limite de linii, număr de aprobări |
| `.github/skills/sdd-stacked-prs/SKILL.md` | Skill-ul care îl învață pe agent fluxul (leagă skill-urile superpowers de `gh stack`) |
| `.github/hooks/sdd-stack.json` + `.github/sdd-stack/guard.mjs` | Hook `preToolUse`: blochează **agentul** local (CLI, cloud agent, VS Code) |
| `.github/workflows/sdd-stack.yml` + `.github/sdd-stack/ci-check.mjs` | Verificare pe server: status `sdd-stack` pe fiecare PR — impune regulile pentru **toată echipa**, nu doar pentru agent |
| `.github/copilot-instructions.md` | Spune mereu agentului să folosească skill-ul |
| `.github/CODEOWNERS`, `pull_request_template.md` | Cine aprobă spec-urile și politica; șablon de PR |

## Ce blochează hook-ul (agentul)

- commit pe `main`, push la `main`, `git push --force`
- editarea codului pe `main` (doc-urile de spec/plan sunt permise, ca brainstorming-ul să poată scrie spec-ul)
- `gh pr create` (trebuie `gh stack submit`), `gh pr merge`, `gh stack merge`, `gh pr review --approve`
- un stack care nu pornește cu `<feature>/spec`; nume de branch invalide
- **orice** branch impl/tests, editare, commit sau push pentru un feature al cărui PR de spec nu e aprobat (verificat live prin `gh`)
- cod în stratul de spec, modificări de spec în straturile impl, cod (non-test) în straturile de teste
- un commit care duce un strat peste limita lui de linii → agentul trebuie să facă `gh stack add` pentru un strat nou

## Ce verifică CI (pentru toată lumea)

Statusul `sdd-stack` pică dacă: numele branch-ului nu e un strat, căile nu corespund tipului de strat, se depășește limita de linii, spec-ul nu e aprobat sau un PR impl țintește `main` direct înainte ca spec-ul să fie merge-uit. Când cineva aprobă PR-ul de spec, workflow-ul reevaluează automat toate PR-urile deschise ale acelui feature și le face verzi.
Scripturile și politica sunt luate mereu de pe branch-ul implicit, deci un PR nu poate relaxa regulile după care e verificat.

## Instalare

1. Copiază `.github/` în repo (îmbină cu fișierele existente `copilot-instructions.md` / `CODEOWNERS`). Înlocuiește `@YOUR-ORG/...` în CODEOWNERS.
2. Pe fiecare mașină de dev:
   ```bash
   gh extension install github/gh-stack          # gh ≥ 2.90
   gh skill install github/gh-stack              # opțional: skill-ul oficial gh-stack
   copilot plugin marketplace add obra/superpowers-marketplace
   copilot plugin install superpowers@superpowers-marketplace
   ```
   Node 18+ trebuie să fie în PATH (Copilot CLI îl are deja).
3. **Ruleset** în Settings → Rules, aplicat pe `main` **și** pe `*/spec`, `*/impl-*`, `*/tests-*`:
   - Require a pull request, 1 approval, require review from Code Owners
   - Require status checks: `sdd-stack`
   - Block force pushes (pe `main`)
4. Ajustează `.github/sdd-stack.json`: căile pentru spec (de ex. `specs/**` dacă folosiți spec-kit), tiparele de teste pentru stack-ul vostru, limitele de linii.

## Cum se împacă cu superpowers

Superpowers are deja propriile porți (design aprobat în chat → plan → implementare), iar spec-urile și planurile le salvează în `docs/superpowers/specs|plans`, pe care politica le tratează deja ca spec. Punctele de conflict și cum sunt rezolvate:

| Superpowers | Conflict | Rezolvare |
|---|---|---|
| brainstorming face commit la design doc | ar fi pe `main` | hook-ul blochează; skill-ul cere `gh stack init <feature>/spec` înainte |
| using-git-worktrees | numele branch-ului nu e definit → nu e strat | worktree creat direct pe `<feature>/spec`; hook-ul sugerează `git branch -m` |
| subagent-driven-development rulează toate taskurile fără pauză | ar depăși limita de linii a unui strat | planul are secțiuni `## Layer …`; controller-ul face `gh stack add` la fiecare secțiune |
| executarea începe imediat după plan | ar sări peste aprobarea echipei | skill-ul cere stop după submit; hook-ul blochează orice strat impl până la approve |
| finishing-a-development-branch: merge local / push + PR | ocolește stack-ul | `git merge` pe `main` și `gh pr create` sunt blocate; singurul final e `gh stack submit` |

## Limitări

- Hook-urile controlează doar agentul. Un dev care lucrează manual e oprit de CI și de ruleset, nu de hook.
- Rulează în Copilot CLI și în cloud agent. Hook-urile din VS Code sunt mai noi; scriptul acceptă ambele formate de payload, dar testați la voi.
- PR-uri din fork-uri: token-ul `pull_request` nu poate scrie statusuri. Pentru o echipă internă nu contează.
- Superpowers `finishing-a-development-branch` oferă merge/PR; skill-ul îi spune agentului să-l înlocuiască cu `gh stack submit`, iar hook-ul blochează oricum `gh pr create`/`merge`.
