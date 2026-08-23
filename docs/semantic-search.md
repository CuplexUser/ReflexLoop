# Semantic search

`research_note_search` and `lesson_search` embed with Qdrant Cloud Inference
and rank by vector similarity when Qdrant is configured, so a lesson written
for "VS Code extension for productivity" can still surface for a proposal in
"VS Code extensions" — wording doesn't have to match. Without it configured,
both fall back to the original `LIKE`-based search, so nothing breaks if you
skip it. `MemoryStore.syncToQdrant()` runs once at startup to backfill any
rows that were written before Qdrant was configured.

Configuration is four env vars, all required together — see
[Setup and configuration](configuration.md#environment).
