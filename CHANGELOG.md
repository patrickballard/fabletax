# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-10

### Added

- Audit report with three taxes, each computed from real token counts in your
  local Claude Code transcripts and a dated price table:
  - Bloat tax: the cost of context carried beyond 200k tokens on main-thread
    turns (`--cap` changes the 200k line).
  - Idle tax: the cost of re-writing already-cached context after the prompt
    cache expired.
  - Inheritance tax: the cost of subagent runs dispatched without a `model:`
    that ran on the main model, repriced on Sonnet 5.5 (or Haiku 5.5 with
    `--as haiku`). Forks, pinned runs and runs whose dispatch cannot be found
    are never counted.
- Dated price table in a single file (`src/prices.mjs`), with a `prices`
  command that prints it.
- `fabletax fix`: prints a plan, asks before applying, backs up every file it
  changes and supports `--undo`. It:
  - sets `autoCompactWindow` to 200000 in `~/.claude/settings.json`
    (`--cap` changes the value, `--no-compact` skips it),
  - installs the guard hook (`--no-hook` skips it),
  - adds `model:` to custom agents that have none (`--no-agents` skips it).
- Guard hook: a PreToolUse hook that adds `model: sonnet` to `Agent` and `Task`
  calls that pass no model when the dispatching model is pricier than the
  target. An explicit `model:` always wins. Forks, plugin agents and other
  built-in agent types are left alone. `FABLETAX_GUARD=off` disables it and
  `FABLETAX_MODEL` changes the target.
- Config audit: unpinned custom agents, guard hook, `CLAUDE_CODE_SUBAGENT_MODEL`,
  auto-compact window, and whether auto-compact or idle compaction is off.
- Claude Code plugin packaging (plugin manifest, marketplace entry, hook
  configuration, and an `/fabletax:audit` skill).
- `--json` output with `report` and `config` fields.
- `--share` mode that leaves out project names and descriptions, so the report
  is safe to screenshot.
- `docs/HOW-IT-WORKS.md`: exact definitions, formulas and known inaccuracies.
