---
owner: engineering
status: current
last_verified: 2026-08-19
---

# Code comment policy

Comments document constraints that code and types cannot make obvious. They are
not a second architecture document or a changelog.

Keep a comment when it explains a current security or tenancy invariant, a
transaction/compensation rule, a queue state transition, a non-obvious formula,
or a provider/runtime limitation. Public ports may also document caller-facing
contracts.

Prefer a named function, type, or constant when prose only restates what the code
does. Private implementation comments should normally be one or two sentences.
Longer comments require a current invariant and should link to a stable test,
ADR, runbook, or platform document when supporting context is necessary.

Do not put these in production source:

- incident timelines, measurements, or rollout narratives;
- Python-port or old-implementation parity notes;
- anonymous checklist labels such as `P0-A` or `issue #4`;
- links to documents that do not exist in this repository;
- provider, deployment, or model claims owned by Wrangler/configuration;
- prose that merely translates the next statement into English.

During review, verify every edited comment against current code/config. Dated
evidence belongs under `docs/`; current architecture belongs under `.codex/` as
defined by `.codex/README.md`.
