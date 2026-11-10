---
name: audit
description: Audit avoidable Claude Code spend from local transcripts. Use when the user asks where their Claude Code spend went, why sessions or subagents are expensive, whether subagents are running on the main (expensive) model, how much long contexts or cold resumes cost them, or to audit their model usage or token costs.
---

# fabletax audit

fabletax reads local Claude Code transcripts and reports three kinds of
avoidable spend: the bloat tax (context carried beyond 200k tokens on every
turn), the idle tax (context re-cached after the prompt cache expired) and the
inheritance tax (subagents dispatched with no `model:` that ran on the
expensive main model).

1. Run the audit (read-only, no network):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/fabletax.mjs" --no-color
   ```

   If the user asked for a time window or a different comparison, pass it
   through: `--days N` (or `--all`), `--as sonnet|haiku`, `--cap <tokens>`.
   Pass `--project <name>` if they named a project.

2. Show the TAX box from the output verbatim, in a code block. Then summarise
   in a few lines: total spend, the three taxes, the worst sessions, and any
   red items under Config.

3. Say it is an estimate (real token counts repriced at list price), not a
   bill.

4. If the tax is above zero or Config has red items, offer to run
   `node "${CLAUDE_PLUGIN_ROOT}/bin/fabletax.mjs" fix`. Do NOT run `fix` unless
   the user asks. `fix` shows its plan first, backs up every file it touches,
   and can be reverted with `fix --undo`.
