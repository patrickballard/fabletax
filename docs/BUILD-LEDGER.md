# Build ledger

fabletax v0.1.0 was built in one Claude Code session on 2026-11-10 with
Fable 5.2 as the orchestrator and pinned Sonnet 5.5 / Haiku 5.5 subagents.
Every subagent dispatch passed `model:` explicitly;
`CLAUDE_CODE_SUBAGENT_MODEL` was not set. The figures below are fabletax's own
reading of that session's transcripts, at list price, taken just before the
final summary was written.

| Model | API calls | Cost | Same tokens at Fable 5.2 prices |
| --- | ---: | ---: | ---: |
| Fable 5.2 (orchestrator) | 55 | $10.19 | $10.19 |
| Sonnet 5.5 (subagents) | 169 | $8.50 | $30.25 |
| Haiku 5.5 (subagents) | 14 | $0.05 | $3.07 |
| **Total** | **238** | **$18.74** | **$43.51** |

Delegating cost $18.74 instead of an estimated $43.51 (57% less). The
estimate assumes Fable would have used the same number of tokens for the
delegated work. Three short live tests of the guard hook cost a further $0.90
on Opus 5.5. The orchestrator's own context passed 200k tokens late in the
session, so the session paid $0.27 of bloat tax itself.

| Step | Model | Why this model | Changed the outcome? |
| --- | --- | --- | --- |
| Competitor stars, last commits, open issues | Haiku | Lookup of public facts | Y: showed the auditors are tiny and ccusage owns totals |
| anthropics/claude-code issue scan | Sonnet | Search and categorise | Y: 23 issues on subagent model inheritance, no tool fixing it |
| Hacker News and X scan (Reddit blocked the fetch) | Sonnet | Search and summarise | Y: shaped the launch copy; found no tool enforcing a model per subagent |
| Claude Code docs checks (prices, transcripts, hooks, compaction) | Sonnet | Documentation lookup | Y: corrected the prices in the brief, found the env-var bug was already fixed, found `autoCompactWindow` |
| Concept pick and scoring | Fable | Judgement | Y |
| Price table, cost engine, tax definitions, build spec | Fable | Hardest logic | Y |
| Transcript loader and core tests | Sonnet | Implementation to a spec | Y: also caught the fast-mode premium being counted twice |
| CLI and terminal report | Sonnet | Implementation to a spec | Y |
| Config audit, fix, guard hook, plugin packaging | Sonnet | Implementation to a spec | Y |
| Licence, changelog, CI, issue templates, good-first-issues | Haiku | Boilerplate | N |
| First run on real transcripts | Fable | Review | Y: inheritance was 3% of spend, so the product became three taxes |
| Bloat and idle tax logic | Fable | Hardest logic | Y |
| Live test of the guard hook | Fable | Review | Y: the hook was silently doing nothing; fixed |
| Report rework, new tests, auto-compact fix, CLI wiring | Sonnet | Follow-ups to the same agents | Y |
| README, how-it-works, launch drafts | Sonnet | Writing from supplied facts | Y: one overstated verification claim was corrected in review |
| Demo image and social preview | Sonnet | Rendering script | N |
| Final review and figure sync | Fable | Review | Y: stale plugin metadata and help text fixed |
