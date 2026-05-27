# Current Problems

This file records known architecture constraints. Do not treat these as TODOs to solve during unrelated work; use them as context for future performance and platform decisions.

## Global User Base

Primary users are expected across America, Europe, India, and China. Global coverage is a core reason this repo uses Cloudflare Workers: request handling can run close to users without managing always-on regional instances.

## Database Latency

The system currently has one Neon Postgres database. There are no regional databases and no cross-origin read replicas.

This is a major latency bottleneck for global users because every DB-heavy request eventually pays distance to the single database region. Even from India, where the current NeonDB is located, latency is still poor because retrieval also depends on external AI services that are US-based.

## External AI Latency

Retrieval calls OpenAI for query embeddings and ZeroEntropy for reranking. Both are effectively US-based from our perspective, so users far from those services pay network latency even when the Worker and database are closer.

This is especially painful because retrieval is user-facing and should be as fast as possible. The target is ideally sub-second without sacrificing result quality, accuracy, or ranking behavior. Current retrieval latency is a couple of seconds.

## Cost Constraints

Budget is a real constraint. Cloudflare Workers are attractive because they bill mostly for active CPU time rather than wall time, unlike AWS Lambda-style wall-time billing. Always-on instances are also wasteful for the current stage and add scaling/ops overhead.

Architecture decisions should respect this constraint unless there is a clear product need and cost justification.

## Ingestion Durability And Speed

Ingestion is allowed to be eventually consistent, which is why it runs through Cloudflare Queues. It can take time, but it must be durable: once the user submits data, it must not be lost.

The current TypeScript/Workers ingestion path appears slower than the Python version. Rough observed numbers:

- TypeScript/Workers ingestion: about `34s`
- Python ingestion: about `14s`

This gap is too large and should be investigated separately. Do not compromise durability to improve ingestion speed.
