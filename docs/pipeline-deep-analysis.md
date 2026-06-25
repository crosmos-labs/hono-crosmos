# Crosmos Ingestion + Retrieval — Deep Analysis & Fix Roadmap

Based on a 4-agent forensic investigation of the LongMemEval-S full-500 run
(`run_158adfb3`, **72.6% accuracy / 98.2% retrieval recall**). Sources: the
ingestion code (`apps/ingestion`), retrieval code (`apps/api/src/features/search`),
the 500-question result data (`benchmark/report-158adfb3.json` + `runs.db`), and
LongMemEval/Zep/mem0 SOTA literature.

---

## TL;DR — the one thing to internalize

**Retrieval is essentially solved. The points are bleeding out *after* retrieval.**

- **98.2% retrieval recall** (over evidence-bearing questions) — the gold evidence
  is in the top-10 almost every time.
- Of **137 failures, 122 (89%) had perfect recall (=1.0)** and failed at the
  **answer-generation** step. Only **12 (8.8%) were retrieval misses**.
- So the accuracy ceiling is gated by **how retrieved memories are turned into an
  answer**, not by what's retrieved.

> **Implementation status (2026-06-19).** Track 1 (#1 timestamps + chronological
> sort, #2 answer prompt, #3 canonical judge rubrics) is implemented in the
> benchmark harness. Engine: #5 post-rerank relevance floor (`apps/api`,
> retrieval-only), #6 conversation chunking (done earlier), and #7 first-class
> assistant-fact extraction (`apps/ingestion` prompt) are implemented. **#8
> supersession is deferred** (needs design). #9 speed / #10 query decomposition
> not started. Validation: #1–#3 + #5 are retrieval-only (re-run against the live
> 500-state, no re-ingest); #6 + #7 require a full re-ingest.
>
> **Validated 2026-06-19 (retrieval-only, Track 1 + #5, no re-ingest).** On a
> stratified 251-question subset (≈half of every category), measured against the
> same 251 in the baseline run_158adfb3: **accuracy 68.5% → 76.5% (+8.0 pts),
> recall 98.4% UNCHANGED** (the #5 floor cost no recall). Per-category:
> knowledge-update +25 (67→92), preference +13, temporal +12,
> single-session-assistant +11 (prompt only), single-session-user +3,
> multi-session −6 (a "prefer-recent"/terse prompt first hurt aggregation −13;
> scoping recency to conflicting updates + "enumerate every item, count once"
> recovered it). #6 chunking + #7 assistant-fact extraction are NOT yet in these
> numbers — they need a re-ingest and should lift single-session-assistant
> further. Also surfaced `source_id`/`session_id` in the `/search` response
> (was missing on `bench-fixes`), required for recall.

The two dominant failure shapes:
1. **"Information unavailable" when it wasn't (47 cases)** — the model refused to
   answer questions whose evidence *was* in its context. 21 of these are in
   `single-session-assistant` (our worst category, 52%).
2. **Stale / ambiguous value on knowledge-update (~22 cases)** — when the user
   changed a fact over time, the model returned the old value or hedged between
   both, because **timestamps are never surfaced to the answer model**.

---

## 1. Failure taxonomy (the 137 misses)

| Bucket | Meaning | Count | % |
|---|---|---|---|
| **B — Retrieval OK, answer wrong** | recall=1.0, answer genuinely wrong | **119** | **87%** |
| A — Retrieval miss | recall < 1.0 | 12 | 9% |
| C — Judge false-negative | answer correct, judge said No | 3 | 2% |
| ABS — Over-answered an abstention question | no evidence existed | 3 | 2% |

### Bucket B sub-shapes (where the real story is)
| Sub-shape | Count | Notes |
|---|---|---|
| **B1 — "unavailable" despite recall=1.0** | **47** | model refused; evidence was in context. 21 = single-session-assistant |
| **B3 — committed to a wrong value** | **63** | date-math off-by-N (temporal), counting errors (multi-session), **stale value** (knowledge-update) |
| **B2 — found conflict, wouldn't commit** | **9** | all knowledge-update — returned old+new, hedged |

### Per-category (every category fails on the *answer*, not retrieval)
| Category | Acc | Retrieval miss (A) | Answer wrong (B) |
|---|---|---|---|
| single-session-user | 91% | 0 | 5 |
| multi-session | 81% | 4 | 20 |
| temporal-reasoning | 68% | 5 | 35 |
| knowledge-update | 67% | 0 | 26 |
| single-session-preference | 67% | 1 | 9 |
| **single-session-assistant** | **52%** | 2 | **24** |

### Recall number, settled
- 453 probes recall=1.0; 13 partial; 4 zero; **30 null = exactly the 30 abstention
  questions** (no gold evidence to retrieve).
- **Honest recall = 98.2%** (over the 470 evidence-bearing probes). The 92.3%
  figure penalizes abstention questions as 0 and understates it. Report 98.2%
  recall + abstention accuracy (27/30 = 90%) separately.

---

## 2. Root causes — what's missing and *why* it hurts

### 2.1 The answer-generation layer (biggest lever — ~70 questions live here)
The benchmark turns retrieved memories into an answer with a thin prompt, and
**this is where most points are lost.** (`benchmark/adapters/longmemeval.ts`,
`crosmos-http.ts`.) These are also exactly what a *real consumer app* must get
right — Crosmos `/search` returns the right data; the consumer just has to use it.

- **Timestamps are dropped.** `/search` returns `event_time`, `created_at`,
  `recorded_at` per candidate (`search/schemas.ts:50-70`), but the harness's
  `extractCandidates` reads only `content`/`score`/`session_id` and throws the
  dates away. → The answer model is **time-blind**.
- **Candidates aren't time-sorted.** They go into the prompt in rerank-score order.
  The LongMemEval paper's #1 recommendation is *"retrieved items are always sorted
  by their timestamp to help the reader maintain temporal consistency."* We do the
  opposite. → directly causes temporal-reasoning (68%) + knowledge-update (67%)
  failures; the model can't tell which fact is current.
- **No recency preference, no concision, no chain-of-note, weak abstention.** The
  system prompt is one line. Gold answers are short; nothing tells the model to
  answer tersely, to prefer the most-recent fact, or to refuse cleanly. → B1
  ("unavailable") and verbose-answer judge rejections.

### 2.2 Ingestion gaps (Crosmos product)
- **No conversation chunking (dead code).** `POST /conversations` stores the
  *entire session as one source / one chunk* (`conversations/routes.ts:142`).
  `segmentMessages`/`buildContext` (4-turn windows + lookback) **exist but are
  wired to nothing** (`conversations/sessions.ts`). Extracting facts from a whole
  long session under-extracts and produces coarse memories → high recall (finds
  *a* memory) but low precision/answer-extractability. Re-wiring the existing
  segmentation is the **highest-ROI ingestion fix**.
- **Assistant-content filter drops the facts single-session-assistant needs.** The
  extraction prompt's `## STRICT EXCLUSIONS` deliberately skips assistant-stated
  facts (`prompts/memories.ts:14-24`). But that category's questions are *about
  what the assistant told the user* (computed values, recommendations the user
  acted on). mem0's +53.6 on this category came from treating assistant facts as
  first-class. This is a genuine cause of the 52% score.
- **No fact-supersession / `valid_to`.** `forgotten_at` exists on memories+edges
  but ingestion **never writes it**; edges have `valid_from` only (no closed
  interval). When a fact updates, old + new coexist with equal standing → the
  knowledge-update + temporal categories retrieve stale and current together.
- Minor: no `max_tokens` on extraction (truncation risk on huge sessions); entity
  resolution has no LLM tie-breaker for the 60–90 fuzzy band (graph fragmentation);
  only LLM-rewritten facts are embedded, never raw turns (extraction misses are
  unrecoverable).

### 2.3 Retrieval gaps (Crosmos product — recall is fine, precision/speed are not)
- **No post-rerank relevance cutoff.** zerank-2 produces a calibrated [0,1]
  relevance score per candidate, but it's used only to *order* — the engine always
  returns `slice(0, topK=10)` regardless of whether items 3–10 are relevant
  (`service.ts:438`). When the gold is 1–2 memories, 8 distractors get handed to
  the answer model. **Adding a score floor is a ~10-line, latency-free precision
  win** that directly helps B1/B3.
- **No fact-supersession dedup at retrieval.** Stale + current memories are
  returned together; the ±0.3-capped recency boost can't reliably demote a stale
  fact the reranker liked. No "latest-valid per (entity, attribute)" collapse.
- **No query understanding.** The "deterministic intent classification" (`intent.ts`)
  is **dead code, not wired in**. No query rewriting / decomposition / multi-query /
  HyDE. Compound temporal + multi-session questions get embedded as one blurry
  centroid. (Lower priority — recall is already 98%.)
- **Speed: `SELECT *` full working-set load.** `candidates.ts:22-38` loads *every*
  memory + entity row in the space per query (O(N)) to enforce per-user visibility
  the vector store can't express. Fine at LongMemEval scale, #1 scaling risk in
  prod. Fix: project only needed columns + lazy-hydrate only the fused pool (~200
  ids), and add a Qdrant `hnsw_ef` floor to protect ANN recall at scale.
- Equal RRF weights (semantic not up-weighted), MMR/diversity off by default —
  secondary tuning levers.

---

## 3. Fix roadmap — prioritized by points-per-effort

Baseline 363/500 = 72.6%. Each question = 0.2%.

### Track 1 — Answer-context fixes (biggest + fastest; "how to consume Crosmos")
These don't change the Crosmos *engine* — they change how retrieved memories are
formatted into the answer. They recover the most points and represent the
**correct way for any app to consume `/search`.**

| # | Fix | Targets | Est. recovery |
|---|---|---|---|
| 1 | **Surface `event_time`/`created_at` into the answer context + sort candidates chronologically** | temporal, knowledge-update | **+15–25 Q** |
| 2 | **Answer prompt: answer tersely, prefer most-recent fact, use the context (don't say "unavailable" if present), abstain cleanly** | B1 (47), knowledge-update | **+25–35 Q** |
| 3 | Use canonical LongMemEval per-category judge prompts (evaluate_qa.py) + harden yes/no parse | single-session-assistant, preference, fairness of the number | +3–8 Q |
| 4 | Lock answer model to the intended tier; consider gpt-4o reader for the assistant category | single-session-assistant | a few Q |

**Track 1 alone plausibly lifts ~72.6% → ~82–84%** with zero engine changes.

### Track 2 — Crosmos product changes (improve the actual memory system)
| # | Fix | Targets | Effort |
|---|---|---|---|
| 5 | **Add a post-rerank relevance cutoff** (drop candidates below a zerank-2 score floor / relative gap) | precision → B1/B3 across the board | **Low** (~10 lines, `service.ts` §8) |
| 6 | **Re-wire conversation segmentation** (4-turn segments + lookback — code already exists) | single-session-assistant, preference (extraction granularity) | Low-Med |
| 7 | **Extract assistant-turn facts as first-class** (relax the assistant-content filter, scoped) | single-session-assistant (52%) | Med |
| 8 | **Fact-supersession**: write `forgotten_at`/`superseded_by` on update + add edge `valid_to`; collapse to latest-valid per (entity,attribute) at retrieval | knowledge-update, temporal | Med-High |
| 9 | Speed: projection + lazy-hydrate the candidate load; Qdrant `hnsw_ef` floor | latency at scale (no quality change) | Low-Med |
| 10 | Query decomposition / multi-query (replace dead `intent.ts`) | hardest multi-session / temporal | High (do last) |

### Sequencing
1. **Track 1 (#1, #2)** first — cheapest, biggest, and it's the reference consumer
   pattern. Re-run retrieval-only against the existing backup (no re-ingest) to
   measure — exactly the workflow we set up.
2. **#5 (rerank cutoff)** — tiny engine change, complements #1/#2 by cleaning the
   context.
3. **#3 (canonical judge)** to get a comparable, fair number.
4. Then product depth: **#6 chunking, #7 assistant facts, #8 supersession** — these
   move the actual product and the two hardest categories.
5. **#9 speed** for prod scale; **#10** only if you plateau.

---

## 4. How to validate each fix cheaply

The backups make this a tight loop:
- **Track-1 / #5 / #3 (retrieval + answer + judge)** change *nothing* in ingestion
  → re-run with `reuseNamespace:true` against the restored 500-state backup. Each
  iteration is ~15–20 min (search→generate→judge only), not hours.
- **#6 / #7 / #8 (ingestion)** require a re-ingest from the LongMemEval dataset
  (slow, but ingestion is allowed to be slow). Snapshot a new backup after each.

---

## 5. SOTA context (LongMemEval-S, 500q)
| System | Reader | Overall | temporal | knowledge-update | single-sess-asst |
|---|---|---|---|---|---|
| **Crosmos (now)** | gpt-4.1-mini | **72.6** | 68 | 67 | **52** |
| Zep/Graphiti | gpt-4o-mini | 63.8 | 54 | 74 | 75 |
| Zep/Graphiti | gpt-4o | 71.2 | 62 | 83 | 80 |
| mem0 (2026) | — | ~94 reported | high | ~100 | 97 |

Crosmos already beats Zep-gpt-4o-mini overall and ties Zep-gpt-4o — on **retrieval**.
The gap to mem0/Zep is concentrated in `single-session-assistant` and
`knowledge-update`, which the literature attributes to **(a) timestamped,
time-sorted answer context** (paper's headline finding) and **(b) treating
assistant facts as first-class** (mem0). Both are in our Track 1 / #7.

Refs: LongMemEval (arXiv 2410.10813), Zep (arXiv 2501.13956), mem0 2026 benchmarks.
