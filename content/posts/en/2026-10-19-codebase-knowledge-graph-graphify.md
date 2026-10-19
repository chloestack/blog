---
title: "Turning a Codebase into a Knowledge Graph with Graphify"
date: "2026-10-19 17:18"
category: "AI"
tags: ["Graphify", "knowledge graph", "AI agent", "vector RAG", "code navigation"]
excerpt: "Learn how Graphify builds a deterministic code graph without an LLM, and when to choose it over vector RAG for AI agent code navigation."
koSlug: "2026-10-19-Graphify로-코드베이스를-지식-그래프로-전환하기"
---

## Table of Contents

1. Overview
2. How the Knowledge Graph Conversion Works
3. Installation and First Graph Build
4. Agent Queries — query · path · explain
5. Differences from Vector RAG and Trade-offs
6. Production Use: Git Hooks, Incremental Updates, and Secret Management
7. Closing Thoughts

---

## Overview

### The Problem: AI Agents Trapped in File Traversal

Once a codebase grows past a few thousand files, context exhaustion becomes a real ceiling for agents. This post covers how Graphify builds a knowledge graph without LLM costs, how to navigate that graph with the three commands query, path, and explain, and when to choose it over vector RAG — and when not to. Whether you use Claude Code or Cursor, mainstream agents today understand code by opening files one at a time with `Read` or `Glob`, or by pulling matching snippets via a search term. On codebases with hundreds of thousands of lines, that approach hits two walls. First, the context window drains fast — reading irrelevant files drives token costs up unintentionally. Second, file-level search cannot capture **structural relationships between concepts**. How `UserService` calls `AuthMiddleware`, or how `PaymentSchema` and `OrderModel` are connected, is hard to grasp fully by reading a handful of files.

**Graphify** solves this by converting an entire codebase into a **queryable knowledge graph**. Code, documentation, SQL schemas, config files, and PDFs all merge into a single graph, and agents query the graph instead of traversing the original files. As of October 2026 it has roughly 128,000 GitHub stars (Apache-2.0), and it can be called directly as a `/graphify` skill in Claude Code, Cursor, Codex, and Gemini CLI (in Codex, use `$graphify`).

### Limits of Existing Approaches

Traditional code navigation tools fall into two camps. The first is **keyword and regex search** — connecting `grep` or `ripgrep` to an agent. It provides nothing beyond string matching and shows no semantic connection between concepts. The second is **vector-embedding-based RAG**: embed code chunks and retrieve relevant snippets by similarity search. This handles semantic similarity well but struggles to represent structural relationships (call chains, inheritance, import chains) without loss, and rebuilding the index incurs embedding API costs every time.

Graphify builds its graph deterministically via tree-sitter AST parsing, with no embeddings. How it differs from both approaches is covered next, alongside how it works.

```diagram
en/2026-10-19-6b5f07e6-01
```

A single codebase is converted into three artifacts; agents query `graph.json` instead of the original files.

---

## How the Knowledge Graph Conversion Works

### tree-sitter AST Parsing

The core engine Graphify uses to build a code graph is **tree-sitter**, an incremental parser library that converts source files into ASTs for any language with a defined grammar. Graphify extracts function definitions, class declarations, import statements, and call expressions from those ASTs and turns them into nodes and edges. The README lists support for roughly 40 languages.

The key property at this stage is **deterministic execution**. Parsing the same source twice always produces the same graph. **No LLM is involved, so there are no network requests and no external API costs. The entire process of building the code graph completes locally.** That determinism is what guarantees consistency when a CI pipeline automatically rebuilds the graph. Unlike embedding approaches that cannot guarantee identical results each run, the graph is identical as long as the source is identical.

Documents, PDFs, images, and video are a different story. Extracting meaning from unstructured content requires an assistant model or a separately configured API key. Graphify supports multiple backends — ollama, openai, gemini, anthropic, bedrock, and others — so organizations can reuse their existing LLM contracts.

```diagram
en/2026-10-19-6b5f07e6-02
```

Code nodes join the graph without an LLM; document and PDF nodes go through an assistant model before joining the same graph.

---

### EXTRACTED and INFERRED Edge Tags

Every edge Graphify adds to the graph carries a trust tag. `EXTRACTED` means the relationship is explicitly present in the source. If the statement `import UserService from './user'` actually exists, that import edge is tagged `[EXTRACTED]`. `INFERRED` means Graphify inferred the connection from context — it applies when there is no explicit reference but a naming pattern or shared type signature suggests a link.

This distinction matters in real projects because agents acting on the graph need to know the strength of a connection when deciding what to do. Following an `INFERRED` edge to decide the scope of a change risks touching the wrong files. The README example output for `graphify explain "APIRouter"` shows each connection labeled `[EXTRACTED]` or `[INFERRED]`, so an agent can navigate with awareness of how reliable each link is.

```diagram
en/2026-10-19-6b5f07e6-03
```

Distinguishing edge trust lets agents treat explicit and inferred relationships differently.

### Community Detection and God Nodes

After building the graph, Graphify automatically partitions it into communities using the **Leiden algorithm**. Leiden finds densely connected clusters from graph topology alone, no LLM needed. Those communities correspond to subsystems in the codebase. When first exploring a large monorepo without domain knowledge, they give a quick signal about which files belong to which domain. Labels are also generated automatically, without an LLM.

**God nodes** are the concepts with the highest degree — the classes or modules with the most connections. Changing a god node has a wide blast radius. The `GRAPH_REPORT.md` lists them, so an agent can consult the list before a code review or refactor to reduce unintended impact. Knowing a node is a god node before touching it and not knowing are meaningfully different from a safety standpoint.

---

## Installation and First Graph Build

### Installation

You need Python 3.10 or later and `uv` (or `pipx`). Note that the PyPI package name is `graphifyy` — two y's. There is an unrelated package with a similar name. The CLI command itself is `graphify`.

After installing, `graphify install` sets it up system-wide; `graphify install --project` installs it per repository. The per-repo option creates a `.graphify/` config file at the project root and lets the whole team share the same graph configuration. For collaborative projects, `--project` is recommended so the config lives in version control.

```diagram
en/2026-10-19-6b5f07e6-04
```

For team projects, a per-repo install lets everyone share the graph configuration.

### First Graph Build

After installation, run `/graphify .` from a supported agent such as Claude Code or Gemini CLI to build a graph of the current directory. In Codex, use `$graphify .`. When the build finishes, three files appear under `graphify-out/`.

`graph.html` is an interactive visualization where you can click nodes, filter, and search in a browser. `GRAPH_REPORT.md` is a report listing key concepts, unexpected connections, and suggested questions — useful for anyone approaching the project for the first time. `graph.json` is the full graph data: what the agent queries directly instead of re-reading the original files.

Below is an example of building a graph from a FastAPI codebase and then querying it to explain a specific concept (based on the example in the README).

```bash
# After building the graph, request an explanation of the APIRouter node
graphify explain "APIRouter"
```

Based on the README example, the output shows `routing.py L2210`, Degree 47, with each connection tagged `[EXTRACTED]` or `[INFERRED]` and its relationship type. A single command tells you how central this concept is in the codebase and which modules it connects to — without opening a single file.

### Making Agents Always Use the Graph

Building the graph is only half the picture if agents fall back to reading files the old way. Graphify provides integration settings to prevent that. Running `graphify claude install` installs a hook that steers Claude Code toward the graph path before it opens files one by one with `Read` or `Glob`. Gemini CLI connects the same way. For agents like Codex or Cursor, the same effect is achieved through instruction files such as `AGENTS.md` or `.cursor/rules`.

To remove the integration, use `graphify uninstall`; add the `--purge` flag to also delete the `graphify-out/` directory.

---

## Agent Queries — query · path · explain

### The Role of Each Query Command

Graphify provides three query commands agents use to navigate the graph. Each has a distinct purpose.

`graphify query "<question>"` takes a natural-language question and returns the relevant subgraph. It extracts only the nodes and edges related to the question, not the entire graph, reducing the agent's context consumption. It suits open-ended questions like feature exploration or bug root-cause tracing.

`graphify path A B` finds the shortest path between two concepts. In the README example, `graphify path "FastAPI" "ModelField"` returns a 3-hop shortest path. Useful for understanding dependency chains or tracing how a change propagates. It also helps with impact analysis and deciding test scope.

`graphify explain "<concept>"` expands all connections for a single node, outputting the file location, degree, connection types, and trust tags in one shot. It is the most direct command for quickly getting the full context of an unfamiliar class or module.

```diagram
en/2026-10-19-6b5f07e6-05
```

The three commands serve different purposes, so agents pick the right one based on query intent.

### What Returning a Subgraph Actually Means

The design choice in `graphify query` to return a subgraph rather than the full graph is directly tied to token efficiency. Loading a graph with hundreds of thousands of nodes into an agent's context could actually consume more tokens than traversing files directly. By extracting only the subgraph that matches the question's scope, the agent gets the structural information it needs and leaves the rest in the graph. Graphify Cloud's claim of "80% reduction in agent token consumption" is derived from this architecture, but that number comes from marketing copy and has no independent verification, so real-world results may differ.

### `# NOTE:` / `# WHY:` Comments and ADR Integration

Graphify turns `# NOTE:` and `# WHY:` comments written in source files into separate nodes and connects them to the graph. Comments that reference ADR (Architecture Decision Record) or RFC documents are also linked to the corresponding document nodes via edges. This makes design decisions embedded in the code navigable on the graph.

When an agent queries why a particular class has a certain structure, the response can include a path through a `# WHY:` node to a related ADR. The **design intent** behind the code becomes traceable. The more a team maintains the habit of referencing ADRs in code comments, the more explanatory power the graph gains.

```diagram
en/2026-10-19-6b5f07e6-06
```

When code and design documents are connected on the same graph, an agent can understand "why it was built this way" within the code context itself.

---

## Differences from Vector RAG and Trade-offs

### The Core Difference Between the Two Approaches

Vector-embedding-based RAG and Graphify's graph approach solve the code navigation problem in different ways. Vector RAG projects text chunks into a high-dimensional space and retrieves by semantic similarity. Even if a concept has a different name or comment, similar meaning can land in the same neighborhood — which is an advantage for document search with rich natural-language descriptions. However, structural relationships in code (call chains, inheritance, import dependencies) are not well captured in embeddings, because the fact that `A` calls `B` is not directly reflected in a similarity vector.

Graphify stores **explicit relationships** extracted from ASTs as graph edges, which makes it strong at structural navigation. Queries whose core is relationship traversal — "all paths that call this function", "all classes that inherit from this class" — are much more direct with graph traversal. For searching documents that are primarily natural-language prose by semantic similarity, vector RAG still has the edge.

| Item | Vector RAG | Graphify |
|---|---|---|
| Index method | Embedding vectors | AST parsing → graph |
| Code build cost | Embedding API cost | 0 LLM credits |
| Structural relation traversal | Weak | Strong |
| Semantic similarity search | Strong | Moderate |
| Deterministic rebuild | API-dependent | Locally self-contained |
| Language support | Model-dependent | ~40 via tree-sitter |
| Caveat | Code structure lost | Weak on unstructured prose |

### Interpreting the README Benchmarks

The Graphify README includes benchmarks measured by the authors. LOCOMO (n=300) recall@10: 0.497 (mem0: 0.048, supermemory: 0.149). LongMemEval-S (n=50): 76% (tied with dense RAG). QA accuracy: 45.3%, which is lower than supermemory's 49.7%. These numbers come from the authors and have not been independently verified. The memory benchmarks (LOCOMO, LongMemEval) also map more closely to conversation and document memory scenarios than to codebase navigation, and the lower QA accuracy compared to supermemory is worth keeping in mind. Judging the real-world impact for a given project requires running your own measurements on your own codebase.

```diagram
en/2026-10-19-6b5f07e6-07
```

Graph traversal and vector search have different strengths depending on the nature of the query.

### Dividing Responsibilities with Archify

The same ecosystem includes another skill called Archify. Archify generates an interactive architecture diagram HTML from a codebase. One sentence to tell them apart: Archify makes "a picture for humans," Graphify makes "a graph for agents to query." The two tools serve different purposes and are often used together. A common pattern is to use Archify at onboarding to visualize the full architecture so the team has a shared mental model, then wire up Graphify for ongoing agent work.

---

## Production Use: Git Hooks, Incremental Updates, and Secret Management

### Keeping the Graph Current — Hooks and Incremental Updates

A codebase changes constantly. If the graph goes stale, agents end up referencing functions that no longer exist or dependencies that have changed. Graphify offers two strategies for this.

Running `graphify hook install` installs a Git hook that automatically rebuilds the graph on commit or branch switch. Rebuilding the entire graph on every commit can take a significant amount of time on large repositories. The `--update` flag addresses this. `graphify --update` re-extracts only the changed files and refreshes the graph. For a monorepo with hundreds of thousands of files, incremental update is the practical choice over a full rebuild.

```diagram
en/2026-10-19-6b5f07e6-08
```

On large repositories, incremental updates significantly cut hook execution time.

### Caveats for Document and Unstructured Content Integration

The code graph builds without an LLM, but adding unstructured content like PDFs, images, or video to the graph requires an assistant model or a separately configured API key. If you have many documents or include video subtitle extraction (`faster-whisper + yt-dlp`), API costs are incurred at that stage. Decide upfront whether to include unstructured content, and exclude anything unnecessary via `.graphifyignore` or `--exclude`. `.gitignore` is respected automatically.

Extras (pdf, office, video, mcp, neo4j, falkordb, and others) each require a separate install for the relevant use case. Installing the `mcp` extra lets you run Graphify as an MCP stdio server, connecting it directly to agent frameworks that support MCP. The neo4j and falkordb extras let you export the graph to an external graph database.

### Merging Repositories and Managing Secrets

`graphify merge-graphs` combines graphs from multiple repositories into one. Useful for tracking cross-service dependencies as a single graph in a microservices architecture, but god nodes and `INFERRED` edges grow as more graphs are merged. More inferred connections across service boundaries increases the risk of agents being guided down the wrong path. After merging, reviewing low-confidence edges is necessary.

On the security side, keep in mind that hardcoded secrets, personal information, or internal infrastructure details may be scattered through the codebase. Environment variable files and internal config files should be explicitly excluded via `.graphifyignore`. The graph build itself is locally self-contained, but content can be sent to external APIs during the unstructured content processing stage, so sensitive documents must be blocked from that path.

```diagram
en/2026-10-19-6b5f07e6-09
```

Every additional repository merged increases inferred connections, so reviewing graph quality after a merge matters.

---

## Closing Thoughts

### Key Takeaways

Graphify analyzes a codebase deterministically with tree-sitter AST parsing and merges code, documentation, and PDFs into a single knowledge graph. As described above, the code graph build bypasses LLMs entirely, and every edge carries an `EXTRACTED`/`INFERRED` trust tag so agents navigate with awareness of relationship strength. The three commands — `query`, `path`, and `explain` — surface only the structural information needed, without traversing all files. Leiden community detection and the god node list are tools for quickly getting oriented in a large codebase you are seeing for the first time.

Connecting `# WHY:` comments and ADRs as graph nodes puts code and design intent in the same navigable space. Git hooks and incremental updates let you automate a pipeline that keeps the graph in sync with the codebase, and extras for MCP, neo4j, and others open paths to integrate with existing agent frameworks.

### When to Use It

Graphify is most effective in three situations: the codebase is large enough that an AI agent's file traversal is burning context; the project involves frequent structural navigation like call chains, inheritance, and import dependencies; or ADRs and design documents are separated from the code and that disconnect is a real friction point.

Conversely, if semantic similarity search is the primary need, or the codebase is small, vector RAG or simple file search may be enough. The benchmark numbers come from the authors' own measurements, so results will vary with actual project characteristics. A small pilot on your own codebase before committing is the practical approach. Because it is open source (Apache-2.0), the full feature set is available via the CLI alone, without Graphify Cloud.

```diagram
en/2026-10-19-6b5f07e6-10
```

When both scale and structural navigation patterns apply, Graphify's advantage is clearest.
