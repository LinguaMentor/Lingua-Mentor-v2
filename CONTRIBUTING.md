# Contributing

How work moves from an idea to production. The board is [LinguaMentor Delivery](https://github.com/orgs/LinguaMentor/projects/1); the product source of truth is the PRD, kept privately outside this public repository (see `docs/prd/README.md`).

## Tickets

Every piece of work is an issue created from a template: Epic, Feature, Task, Bug, Spike or Decision. Epics break into features and tasks as sub-issues. Each ticket references the PRD or Calibration Brief section it comes from.

Board fields: Status, Type, Role, Area, Priority, Estimate, Sprint, Milestone.

| Priority | Meaning |
|---|---|
| P0 | Blocks a release, a security issue, or an S1 production bug. Handle now |
| P1 | This sprint |
| P2 | Next sprint |
| P3 | Backlog |

Estimates are story points: 1, 2, 3, 5, 8. Anything larger is split.

## Lifecycle

New / Triage → Backlog → Ready → In Progress → Blocked → In Review → QA Testing → Done → Released

- **New / Triage:** checked within 48 hours. Accepted, closed as duplicate, or labelled `needs-info`.
- **Ready:** meets the Definition of Ready below.
- **In Progress:** a branch exists. At most two tickets in progress per role.
- **Blocked:** add a "blocked by" link and a comment. When cleared, the ticket returns to its previous column.
- **In Review:** PR open, CI gate running, code review by the Tech Lead.
- **QA Testing:** merged and deployed to staging. QA tests every acceptance criterion.
- **Done:** passed QA; QA closes the issue.
- **Released:** shipped in a tagged production release.

If QA finds the ticket doesn't meet its own acceptance criteria, it goes back to In Progress with the `qa-failed` label and a comment listing what failed. The fix is a new PR on the same ticket. Anything else QA finds is a new Bug ticket.

### Definition of Ready

- Acceptance criteria as Given / When / Then, covering every exam level the ticket touches
- PRD or Calibration Brief section referenced
- Role, Area, Priority and Estimate set
- Test plan written by QA
- No open blocker

### Definition of Done

- Every acceptance criterion passes on staging
- Tests added: unit, plus integration and end-to-end where relevant
- CI gate green, PR squash-merged with a conventional-commit title
- Docs and READMEs updated in the same PR
- Security, privacy and analytics notes addressed

## Branches and pull requests

`main` is protected: changes arrive only through a pull request, the `CI gate` check must pass, and history stays linear. Squash is the only merge method.

- Branch: `type/<issue>-<short-slug>`, for example `feat/142-usage-cap`.
- PR title: a conventional commit (`feat(placement): start placement at A1`). It becomes the commit on `main`, so the `PR title` job in CI checks it against the allowed types and scopes (listed in `.github/workflows/ci.yml`), and a bad title fails the CI gate. Titles are re-checked whenever they are edited. Commit messages on your branch aren't checked, since squashing discards them.
- The title mirrors the ticket, so a PR and its issue are recognisable at a glance and `main`'s history reads like the board. Take the ticket title, turn its `[area]` prefix into the scope and lowercase the first letter. Task `[infra] Stop the failing Deploy runs until staging exists` becomes `ci(infra): stop the failing Deploy runs until staging exists`. Leave the issue number out of the title: the branch and the PR body carry it, and GitHub appends the PR number on merge. Every board Area maps to a scope:

  | Area | Scope |
  |---|---|
  | frontend | `frontend` |
  | gateway | `gateway` |
  | ai-service | `ai-service` |
  | worker | `worker` |
  | infra | `infra` |
  | content | `content` |
  | calibration | `calibration` |
  | payments | `billing` |
  | legal | `legal` |

- The type follows the ticket's type on the board. `feat` and `fix` drive release notes and version bumps, so they belong only to the ticket types that mean the same thing:

  | Ticket type | Commit type |
  |---|---|
  | Feature | `feat` |
  | Bug | `fix` |
  | Task, Spike, Decision | whichever of `chore`, `ci`, `build`, `docs`, `refactor`, `test`, `perf`, `style` fits; never `feat` or `fix` |
  | Epic | no PR of its own; its sub-issues get the PRs |

  Dependabot PRs have no ticket and keep `chore(deps)`.
- PR description: the `Type of Change` line repeats the PR title exactly.
- PR body: `Refs #<issue>`, never `Closes #<issue>`. A closing keyword would close the issue at merge and skip QA.
- One ticket per PR, kept small.

## Environments and releases

| Event | Result |
|---|---|
| PR opened | CI only |
| Merge to `main` | Deployed to staging |
| Release tag `vX.Y.Z` | Deployed to production after manual approval |

Versions stay at `v0.x` until Phase 1 launch, which is `v1.0.0`.

## Sprints

Two weeks. Planning at the start against capacity, refinement weekly, a written daily status note, and a review with a staging demo plus a short retrospective at the end.
