# list-templates

> Codex skill: list every harness template `create-harness` can scaffold
> from — the Codex mirror of `.claude-plugin/skills/list-templates`.

## What it does

Prints the template catalog (`templates/catalog.json`, rendered by the
CLI's `--list` flag). Read-only — nothing is scaffolded. Use it to pick a
`template` id before running `/create-harness`.

Each row shows the template id, its `<agents>a/<skills>s/<commands>c`
counts, and a one-line quick-start description, grouped by category.

## Templates today

| Template | Category | Best for |
|---|---|---|
| `minimal` | Starter | First-time users — learn the system, then grow into a vertical |
| `vertical:devops` | Operations | Incident response, on-call, guarded kubectl |
| `vertical:coding` | Engineering | Architect → implement → review → test |
| `vertical:ai` | Engineering | Curate → train → evaluate → deploy with eval gates |
| `vertical:repo-maintainer` | Engineering | Drop into any repo: triage, benchmark, release, security |
| `vertical:research` | Knowledge | Multi-source research dossiers with fact-check + cite |
| `vertical:ruview` | Knowledge | Index → retrieve → review on a ruvector HNSW store |
| `vertical:education` | Knowledge | Tutor → explain → quiz → grade over per-learner memory |
| `vertical:trading` | Finance | Paper-trading bots with circuit-breaker safety |
| `vertical:support` | Customer | Triage → KB-search → respond → escalate |
| `vertical:crm` | Customer | Qualify → manage → watch-churn with lifecycle memory |
| `vertical:sales` | Customer / Growth | Prospect → qualify → demo → close |
| `vertical:legal` | Professional | Redline → citation-check → risk-rate (defers to a licensed human) |
| `vertical:health` | Professional | Intake → triage → coordinate ("see a clinician" hard-coded) |
| `vertical:business` | Business | Analyst → strategist → ops-coordinator with a metrics MCP |
| `vertical:marketing` | Growth | Strategy → content → SEO grounded in analytics |
| `vertical:advertising` | Growth | Media-plan → copy → performance across digital + traditional |
| `vertical:agentics` | Frontier | Orchestrator → planner → workers → critic on a swarm bus |
| `vertical:gaming` | Frontier | Playtest → balance → economy → narrative over build telemetry |
| `vertical:exotic` | Frontier | Hypothesizer → experimenter → federator over a witness-signed evolution log |

The CLI output is the source of truth — the table above is a snapshot and
the catalog grows over time (see `templates/catalog.json`).

## Usage from Codex

```
/list-templates
```

## Equivalent CLI

```bash
npx metaharness --list          # or: npx metaharness --templates
```

## Sample output

```
Available templates:

  Starter
    minimal                0a/0s/1c   The bare scaffold — learn the system, then grow into a vertical.
  Operations
    vertical:devops        4a/0s/1c   4 on-call agents + alerts & runbook-store MCP servers + guarded kubectl perms.
  Engineering
    vertical:coding        4a/1s/2c   Architect → implement → review → test, with a code-index MCP and push-guarded git perms.
  ...

Scaffold with: metaharness <name> --template <id>
```

## Hosts each template supports

Every template scaffolds for every supported host (`claude-code`,
`codex`, `pi-dev`, `hermes`, `openclaw`, `rvm`, `copilot`, `opencode`,
`github-actions`, `prime-agent`) — pass `--host <id>` (repeatable) to
`create-harness`.

## Related skills

- `create-harness` — scaffold a harness from one of these templates
- `example-harness` — one-command scaffold from a published `@metaharness/*` package
- `validate-harness` — release-readiness umbrella for the result

## See also

- [ADR-013 — Vertical packs publishing](../../../docs/adrs/ADR-013-vertical-packs-publishing.md)
