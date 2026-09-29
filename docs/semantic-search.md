# Semantic search

When Qdrant is configured, `research_note_search` and `lesson_search` find results by meaning
rather than exact wording. A lesson written about "VS Code extension for productivity" can still
turn up for a proposal about "VS Code extensions".

The search is hybrid: it combines meaning-based matching with keyword matching, which catches
rare exact terms such as product or competitor names.

Qdrant is optional. Without it, both tools fall back to plain text matching, and nothing breaks.
At startup the agent copies any rows that are not yet in Qdrant, so you can add it at any time.

Setup takes four environment variables, all required together. See
[Setup and configuration](configuration.md#optional).
