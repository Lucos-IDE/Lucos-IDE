# Lucos Chat — Backend Hand-off (Issues 9 & 15)

IDE/daemon fixes for chat UX (issues 8, 10–14) do **not** address these. They need changes in
`adpilot-rag-service.com` and `api.lucos.com`.

## Issue 9 — Answers always framed as “architecture”

**Symptoms:** Ordinary questions (features, how something works, overviews) are answered as if the
user asked for system architecture.

**Root causes**

1. `adpilot-rag-service.com/app/intent/intent_analyzer.py` — `ARCHITECTURE_SIGNALS` is too broad
   (includes phrases like `how does`, `functionality`, `features`, `overview`, `flow`).
2. `adpilot-rag-service.com/app/retrieval/query_rewriter.py` — unconditionally appends something like
   `"README overview architecture main modules…"` to the rewritten query, biasing retrieval.

**Suggested fixes**

- Narrow `ARCHITECTURE_SIGNALS` to explicit architecture intent (`architecture`, `system design`,
  `component diagram`, `module layout`, etc.). Remove generic product/how-to phrasing.
- Stop appending architecture boilerplate in the query rewriter unless intent is architecture.
- Add regression tests: “What features does X have?” and “How does login work?” must not classify
  as architecture or retrieve only README/architecture chunks.

## Issue 15 — Cannot answer general knowledge (e.g. “What is HTML”)

**Symptoms:** With any retrieved chunk present, the model refuses general knowledge and stays
locked to RAG-only answers (or fails when retrieval is weakly related).

**Root causes**

1. `adpilot-rag-service.com/app/generation/prompts.py` + `app/services/query_service.py` — system
   prompt / gating forbids general knowledge whenever *any* chunk is retrieved, not only when
   retrieval is strong/relevant.
2. Weak-retrieval threshold is missing or too low, so unrelated workspace chunks still force
   RAG-only mode.

**Suggested fixes**

- Allow general-knowledge answers when retrieval relevance is low (score/threshold), not only when
  the result set is empty.
- Raise/apply a weak-retrieval threshold before forcing RAG-only mode; if below threshold, answer
  from general knowledge (optionally noting no strong workspace match).
- Regression: “What is HTML?” with an unrelated indexed repo should return a normal HTML definition.

## Model selection not honored end-to-end

Composer model choice is sent from the IDE through the daemon, but
`api.lucos.com/src/services/proxy.service.js` strips `model` (or does not map it through trusted
headers). Until the gateway forwards model, UI selection cannot affect cloud inference.

**Suggested fix:** Stop stripping `model`, or map it to an allowlisted header/field the RAG/LLM
path already trusts.

## Out of scope for Lucos-IDE / local-daemon

Do not implement the above in the IDE or local daemon. Track and land in the RAG service + gateway
repos; then re-verify chat with a live daemon + cloud.
