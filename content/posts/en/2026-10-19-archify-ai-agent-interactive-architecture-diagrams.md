---
title: "What Is Archify? An AI Agent Skill That Turns Code into Interactive Architecture Diagrams"
date: "2026-10-19 11:45"
category: "AI"
tags: ["Archify", "architecture diagrams", "AI agent skill", "Claude Code", "documentation automation", "diagramming tools"]
excerpt: "Archify is an open-source skill for AI coding agents that reads a codebase or description and produces a validated, interactive architecture diagram as a standalone HTML file."
koSlug: "2026-10-19-Archify란-코드를-인터랙티브-아키텍처-다이어그램으로-바꾸는-AI-에이전트-스킬"
---

## Table of Contents

1. Overview
2. How Archify Works — JSON Intermediate Representation and Validation Gates
3. Archify Diagram Types and Viewer Features
4. From Code Repository to Architecture Diagram — Source Evidence Linking
5. Installing Archify and Pre-Adoption Checkpoints
6. Closing Thoughts

---

## Overview

### The Problem Archify Solves

Architecture diagrams start going stale the moment you finish drawing them. Code changes, but the diagram stays the same until someone manually updates it, and anyone new to the project has no way to tell whether the diagram still matches the code. **Archify** hands this problem off to an AI coding agent. Install it as a skill in an agent like Claude Code, Codex CLI, or Cursor, ask it to "draw the runtime architecture of this repository," and the agent reads the code and produces an **interactive architecture diagram** as a single HTML file.

This post is based on reading the README, `SKILL.md`, schemas, and examples in the Archify v3.2.0 repository (released 2026-10-18). No benchmarks were run personally; any judgments about performance or quality stay within what the documentation says.

| Item | Details |
|---|---|
| Repository | `tt-a1i/archify` (GitHub) |
| License | MIT |
| Initial release | 2026-04-15 |
| Latest stable | v3.2.0 (2026-10-18) |
| GitHub stars | ~85,000 (as of 2026-10-19) |
| Supported agents | Claude Code, Codex CLI, Cursor, OpenCode, and others |
| Runtime requirement | Node.js 18+ |

The author also shared a screenshot of the project hitting #1 on GitHub Trending (weekly) in early September 2026.

### How It Differs from Existing Diagramming Tools

**Text-based diagramming tools** like Mermaid and PlantUML require a person to write the syntax. Archify does not. The agent writes JSON conforming to a defined schema, Archify validates that JSON, and then renders it into a diagram. The person writes a natural-language request and reviews the output.

| | Mermaid / PlantUML | Static SVG generation | Archify |
|---|---|---|---|
| Who writes the source | Person | Person or agent | Agent |
| Source format | Domain-specific text syntax | SVG / HTML | Typed JSON |
| Output | Static image | Static image | Navigable standalone HTML |
| Quality checks | Syntax errors only | None | Schema, layout, and browser checks |
| Code evidence links | None | None | Commit-pinned source links |
| Best for | Short inline diagrams in docs | Static visuals for blogs / slides | System maps you navigate while reading |

> Archify describes itself as neither a general-purpose drawing editor nor a Mermaid theme. The project defines itself as a tool that turns technical intent into a deliverable artifact.

---

## How Archify Works — JSON Intermediate Representation and Validation Gates

### Typed JSON Intermediate Representation

The core of Archify is a **typed JSON intermediate representation (IR)**. Instead of writing SVG coordinates directly, the agent writes nodes, relationships, boundaries, and labels in JSON that conforms to a schema defined for each diagram type. The renderer only sees this JSON, so the same JSON always produces the same diagram, and follow-up requests like "add Redis" only require editing the relevant part of the JSON.

Below is an abridged version of the cache-miss sequence example from the repository (`archify/examples/cache-miss-request.sequence.json`), with fields like y-coordinates omitted. Each participant and message carries a meaningful type (`backend`, `database`, `return`, etc.).

```json
{
  "schema_version": 1,
  "diagram_type": "sequence",
  "meta": { "title": "Cache Miss Request Sequence", "quality_profile": "showcase" },
  "participants": [
    { "id": "api",   "type": "backend",  "label": "API",      "sublabel": "request handler" },
    { "id": "redis", "type": "database", "label": "Redis",    "sublabel": "cache" },
    { "id": "db",    "type": "database", "label": "Postgres", "sublabel": "source of truth" }
  ],
  "messages": [
    { "id": "cache-read",    "from": "api",   "to": "redis", "label": "read cache", "variant": "default" },
    { "id": "cache-miss",    "from": "redis", "to": "api",   "label": "miss",       "variant": "return" },
    { "id": "profile-query", "from": "api",   "to": "db",    "label": "query profile + metrics", "variant": "emphasis" }
  ]
}
```

Going through JSON means the agent can pinpoint exactly what to fix without a person manually touching the diagram. The flip side is that if the agent writes bad JSON, the diagram is wrong too — which is why the validation step that follows matters.

### finalize — Four Validation Gates

Once the agent finishes writing a JSON candidate, a single `finalize` command runs everything from validation through delivery. The JSON must pass all four gates in sequence; if any gate fails, the process stops there.

```diagram
en/2026-10-19-archify-01
```

The agent's JSON must clear all four gates to become an HTML file. On failure, the agent reads the diagnostic JSON and may retry up to twice.

| Gate | What it does | On failure |
|---|---|---|
| `validate` | Checks schema, layout rules, path and label spacing | Returns rule codes and fixable items |
| `deliver` | Renders a candidate HTML in the same directory, then replaces the existing file | Keeps the existing file |
| `check` | Strict provenance check on the output | Keeps the existing file |
| `browser-check` | Opens the file in a real browser to verify | Keeps the existing file |

`SKILL.md` is explicit: only a passing receipt counts as success. A non-zero exit code is never a success under any circumstances. The agent reads the failing gate's diagnostic, fixes the issue, and reruns `finalize` from the beginning.

### Machine-Readable Diagnostics on Failure

Failures from agent tools typically look like Node stack traces or vague "please try again" messages. When `validate --json` or `deliver --json` fails, Archify returns **a single JSON object** containing a stable rule code, the offending subject, measured evidence, and the set of supported fixes (`supportedFixes`).

| Diagnostic field | Meaning | What the agent does |
|---|---|---|
| Rule code | Which rule was violated | Distinguishes between error types |
| Subject | The node or relationship at fault | Fixes only that area |
| Measured evidence | Actual values — overlap length, spacing, etc. | Decides how much to shift |
| `supportedFixes` | Allowed correction methods | Stays within these options |

The skill limits correction rounds to **two**. This prevents the agent from retrying the same problem indefinitely. In an earlier post on [LLM Tool Calling design patterns](/en/posts/2026-10-01-llm-tool-calling-design-patterns-reliable-agents) I covered how structuring tool responses improves agent reliability — Archify's diagnostic format is a concrete example of that principle in action.

### Atomic Replacement and the Last Known Good

`deliver` does not overwrite the output file immediately. It creates a candidate in the same directory and only replaces the existing file atomically once the candidate passes inspection.

```diagram
en/2026-10-19-archify-03
```

A candidate that fails inspection cannot touch the existing file — only a failure receipt is written. The optional `preview` mode follows the same principle: if writing the JSON leaves the state corrupted, the last known good version stays on screen.

---

## Archify Diagram Types and Viewer Features

### Ten Diagram Types

Up through v3.0 there were five types. v3.1 (2026-10-14) added ERD, Class, Tree, Timeline, and Waterfall, bringing the total to ten. If you are unsure which type to use, pass a description as a sentence to the `guide` command and it picks the most appropriate one.

| Type | Best fit |
|---|---|
| Architecture | Components, services, storage, boundaries |
| Workflow | CI/CD, approvals, tool calls, runbooks |
| Sequence | API calls, cache fallback, authentication |
| Data Flow | Pipelines, lineage, privacy flows |
| Lifecycle | State transitions, retries, queuing, shutdown |
| ERD | Tables, columns, keys, relationship cardinality |
| Class | Classes, interfaces, dependencies |
| Tree | Module trees, feature decomposition |
| Timeline | Incident retrospectives, release history |
| Waterfall | Latency breakdown for a single request |

Timeline and Waterfall are types where placeholder values can easily slip in. The README calls out explicitly that these should only be treated as measured data when the values come from logs or traces.

### What You Can Do in the Standalone HTML Viewer

The output is a single HTML file. Recipients do not need to install Archify — opening it in a browser gives them full navigation. There are enough keyboard shortcuts to make it useful in presentations and reviews.

| Feature | How to trigger | Use case |
|---|---|---|
| Node search and focus | `/` | Find a specific service in a large map |
| Upstream / downstream tracing | Select a node, then Upstream or Downstream | What does this component depend on, and what does it drive? |
| Path tracing | `R` or PATH | Highlight the actual path from web app to DB |
| Role comparison | `L` or LENS | Show only backend-to-database connections |
| Presentation mode | `F` | Screen sharing in meetings |
| Theme / style / export | `T` / `S` / `E` | Toggle light/dark, export as PNG or SVG |

Focus and path state are preserved in URL fragments like `#focus=api&reach=downstream`, so a specific perspective can be shared as a single link. According to the docs, upstream/downstream tracing only follows **explicitly authored relationships** and makes no claim about inferring runtime blast radius.

### Single-Page Explainer — New in v3.2

v3.2.0 adds a feature for generating **single-page explanation documents**. Ask something like "P99 latency jumped from 80ms to 600ms — what's the cause? Give me a one-pager," and it puts the conclusion first, then lays out one panel per question with tables, steps, charts, and diagrams. Four styles and light/dark themes are available, and you can export as a tall image or PDF.

> Conclusion first, one question per panel. Useful for documents that need "diagram + explanation," such as incident retrospectives or design reviews.

---

## From Code Repository to Architecture Diagram — Source Evidence Linking

### How Repository Evidence Gets Attached to Nodes

**Source evidence** is where Archify diverges most sharply from other diagramming tools. When drawing from a real repository, the agent starts from entry points, follows call sites, and records the file path and line range for each component and relationship it finds. Nodes with evidence get an `SRC n` badge; clicking it in the viewer opens a source card showing those exact lines at a pinned commit.

```diagram
en/2026-10-19-archify-02
```

Evidence comes only from bytes at a pinned commit. Uncommitted working-tree changes are not used as evidence.

| Rule | Details | Reason |
|---|---|---|
| Commit pinning | The 40-character `HEAD` hash and remote URL are recorded in `meta.repository` | Links should point to the same code later |
| Credential stripping | Usernames and tokens are removed from remote URLs before recording | Prevents secrets from leaking into the output |
| Working tree excluded | Uncommitted changes are not used as evidence | Clicking a link should not show different content |
| Web link targets | GitHub, Gitee, GitLab HTTPS remotes | Only hosts that support line-level deep links |
| Everything else | SSH and internal repositories use `local-only` | Records path and revision only |

### The Rule Against Ungrounded Relationships

The repository authoring guide (`references/repository-authoring.md`) sets fairly strict rules for what agents are allowed to draw. The core principle is **do not draw what you have not read**.

| Situation | Allowed? | Guide's verdict |
|---|---|---|
| Code at a call site that verifiably writes to the DB | Yes | Record the read range as evidence |
| Only a description saying it "manages tasks" | No | A responsibility description is not evidence of direct I/O |
| A function that is exported but never called on the happy path | Optional only | Do not draw it as a required runtime relationship |
| A service name only in a config value | No | Do not create a service that was not observed |
| Behavior that could not be confirmed | Mark as unverified | Record as "writeFile call, durability unknown" |

It is also worth noting that there is no target count for nodes or relationships. The guide says to stop exploring once the requested responsibilities and relationships are covered by evidence. This looks like a deliberate design choice to counter the LLM tendency to fill gaps with plausible-sounding labels.

### Before-and-After Comparison — Architecture Delta

For design reviews and PR reviews there is a `compare` command. Give it a before JSON and an after JSON for the architecture, and it draws a single delta diagram showing added, removed, changed, and moved elements, alongside a machine-readable receipt.

> The delta diagram only shows **what changed**. The README explicitly states it does not infer impact, risk, or merge safety — whether the changes are acceptable is still the reviewer's call.

---

## Installing Archify and Pre-Adoption Checkpoints

### Installation and First Request

Installation is a single line with the `skills` CLI. Add `-g` for a global skill available across all projects. On Claude.ai you can upload `archify.zip` through the Skills menu in settings, but because the validation gates run on Node.js, if Node is unavailable in the sandbox the tool falls back to a path without validation.

```bash
# Global install (Claude Code: ~/.claude/skills/, Codex: ~/.agents/skills/)
npx skills add tt-a1i/archify -g

# One-off use without installing
npx skills use tt-a1i/archify@archify --agent codex
```

After installing, just ask the agent in natural language. You can draw from a description alone without a repository; if you have a repository open, you can request a diagram with code evidence attached.

```text
Analyze this repository and use Archify to create a high-level runtime architecture diagram.
Show 8-12 core components, one main path, external dependencies, and trust boundaries.
Put details in cards rather than adding more edges.
```

This is adapted from the example prompt in the README. **Scoping up front** — number of components, main path, boundaries — is what drives output quality. After the diagram is generated, refine it incrementally: "add authentication," "highlight the cache-miss path," and so on. The principles for passing project context to an agent covered in the [Cursor Rules design](/en/posts/2026-10-11-cursor-rules-ai-coding-agent-context) post apply directly here.

### Using the CLI Directly

You can also call the CLI without an agent. It is a Node script with no external dependencies, so cloning the repo and running it directly works fine. Day to day you only need `finalize`; use `guide` when you are unsure which diagram type fits, and `compare` for reviews.

```bash
cd archify
node bin/archify.mjs doctor                          # environment check
node bin/archify.mjs guide "Show CI/CD checks, approval, deploy, and rollback"   # recommend a diagram type
node bin/archify.mjs finalize workflow examples/agent-tool-call.workflow.json /tmp/workflow.html \
  --quality showcase --json                          # validate and deliver in one step
node bin/archify.mjs compare architecture base.json head.json delta.html --json  # before-and-after diff
```

---

### Limitations and Out-of-Scope Items

The project is candid about its limits. The README lists automatic Mermaid parsing, general-purpose auto-layout, hosted sharing, and WYSIWYG editing as currently out of scope.

| Limitation | Details | Workaround |
|---|---|---|
| Perceptual quality | Automated validation does not guarantee a readable diagram | Review important diagrams manually |
| Large Sequence diagrams | Scrolling required beyond screen height; controls may overlap | Split into multiple diagrams with narrower scope |
| Complex Data Flow | Lines may share the same channel | Reduce boundaries and steps in the request |
| Mermaid input | Does not convert syntax directly; reads the meaning and rewrites | Treat existing Mermaid as reference material only |
| Sharing | No hosting feature; distribute as an HTML file | Attach the file to an internal wiki or repository |

The first item deserves emphasis. `SKILL.md` also instructs the agent to distinguish when reporting results — e.g., "automated checks passed, visual review not done." Passing the gates means the schema and layout rules were satisfied, not that the diagram is easy to read.

### Network Requests and Third-Party Services

Teams that need a security review should verify the network behavior ahead of time.

| Item | What the docs say | What to check |
|---|---|---|
| Update check | GETs a pinned stable manifest roughly every 24 hours; does not send version, agent, project data, or prompts | Can be disabled with `ARCHIFY_UPDATE_CHECK_DISABLED=1` |
| Auto-install | Notifies you of updates only; does not install automatically | User decides when to update |

The README includes several sponsor banners for API relay services, but as the project itself notes, these are third-party services unrelated to Archify. Rerouting your agent's API traffic through them is an entirely separate decision from adopting Archify.

---

## Closing Thoughts

Archify's real investment is less in "an agent can draw diagrams" and more in the machinery that makes those diagrams **trustworthy**. The typed JSON IR, the four-gate validation pipeline, machine-readable diagnostics on failure, atomic replacement, and commit-pinned source evidence all point in the same direction: do not trust LLM output as-is; make it verifiable.

| Criterion | Archify is a good fit | Another tool is probably better |
|---|---|---|
| Is this a diagram readers will navigate? | System maps, delta views for reviews | Short static diagrams embedded in docs |
| Does the link to code matter? | Onboarding, architecture walkthroughs | Conceptual diagrams with no code tie-in |
| Are you already using an AI coding agent? | Teams using Claude Code, Codex, or Cursor | Teams where a person draws the diagrams manually |

The most natural use cases are onboarding system maps, delta diagrams for PR reviews, and timelines for incident retrospectives. In short: if you are already using a coding agent and need architecture documentation that stays in sync with the code, this is worth trying first. That said, passing automated checks and producing a readable diagram are two different things, so keep a step in your workflow where a human opens the file before sharing it with the team.

References: [Archify GitHub repository](https://github.com/tt-a1i/archify) · [Archify official site and gallery](https://archify.si/gallery.html)
