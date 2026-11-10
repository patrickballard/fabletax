# How fabletax works

This is derived from the code in `src/` and `hooks/`. Where the original build spec differed from the code, the code is what is described here.

## Pipeline

1. `src/transcripts.mjs` reads every `.jsonl` file under `<claudeDir>/projects` and extracts billable API calls.
2. `src/cost.mjs` and `src/prices.mjs` turn each call's token counts into dollars.
3. `src/analyze.mjs` classifies subagent runs and computes the three taxes.
4. `src/config.mjs` audits your settings and agent files.
5. `src/report.mjs` prints the result. `src/fix.mjs` changes files, only when you run `fix`.

`<claudeDir>` is `--claude-dir`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Nothing is sent anywhere. There is no network code.

## What counts as a call

Claude Code writes one transcript line per content block, so a single API response can appear on several lines. fabletax counts a line as a billable call when it has `type: "assistant"`, a `message.usage` object and a model other than `<synthetic>`.

Main threads live in `<slug>/<sessionId>.jsonl`. Subagents live in `<slug>/<sessionId>/**/subagents/agent-<agentId>.jsonl`, with a sibling `.meta.json` holding `agentType`, `description`, `toolUseId` and `spawnDepth`. Older transcripts that mark inline subagent lines with `isSidechain: true` are treated as subagent calls too.

Only lines containing `"usage"` or `"toolUseResult"` are parsed as JSON. Other lines are skipped without parsing, because some of them are very large. Files whose modification time is before the window are skipped, and calls older than the window are dropped.

### De-duplication

- The key is `message.id` plus `requestId`, global across all files. Resumed sessions copy history into new files, so the same call can appear in several.
- On a repeat, the first call is kept. Each usage category takes the maximum of the copies and the timestamp takes the earliest.
- Lines with no `message.id` are counted as they are.

### Token categories

Usage is normalised to five categories: input, output, 5-minute cache write, 1-hour cache write and cache read. If a transcript only has `cache_creation_input_tokens` with no 5m/1h split, those tokens are billed as 5-minute writes. Any remainder the split does not cover is billed the same way.

The prompt size of a call is `input + cache writes + cache reads`.

## Price table

`src/prices.mjs` is the only file with a price in it. It lists USD per million tokens, the date (`PRICES_AS_OF`) and the source URL.

- Cache writes use the published multipliers: 5-minute is 1.25x input, 1-hour is 2x input.
- Cache reads are listed per model. They do not follow one multiplier.
- `fast`: when `usage.speed` is `fast`, every category is multiplied by the model's fast factor.
- US inference: when `usage.inference_geo` is `us`, cost is multiplied by 1.1, except on models flagged `noGeo`.
- `tierOver`: Haiku 5.5 has different prices above 100,000 prompt tokens. They apply per request.
- A model id resolves to a table key if it matches a key exactly, or with a dated snapshot (`-20251101`), a context suffix (`[1m]`) or a provider wrapper. Anything else is treated as unknown. `claude-fable-5-3` is not priced as `claude-fable-5`.
- Calls on unknown models are not guessed. They are counted separately as unpriced and left out of every total, and the report lists them.
- The aliases `fable`, `opus`, `sonnet` and `haiku` each resolve to one fixed table row (see `fabletax prices`). `--as` takes an alias or a model id.

Run `fabletax prices` to print the table. To add a model, see CONTRIBUTING.md.

On 67 of 67 session cost records (Opus 5.5 and Opus 5), Claude Code's own recorded cost fell inside the range the table predicts. Those records do not split cache writes by lifetime, so the check brackets the cost between all-5-minute and all-1-hour writes rather than matching it exactly. That shows the arithmetic is right for those models. It does not cover every model in the table.

## Bloat tax

Applies to main-thread calls only. Subagent contexts are not counted.

For each main-thread turn with a prompt larger than the cap (default 200,000 tokens, `--cap` changes it):

```
bloat = (prompt_tokens - cap) x cache_read_rate / 1,000,000
```

This prices the excess at the cache-read rate, the cheapest those tokens could have been billed. It is a floor for what the extra context cost. If the excess was billed as cache writes, the real cost was higher.

The report shows the number of turns over the cap and the largest prompt seen. 1M-context models auto-compact at about 967k tokens by default, so the largest prompt is usually near that.

## Idle tax

Applies to main-thread calls only. Turns in a session are sorted by time. A turn is a cold resume when all of these hold:

- It follows the previous turn by more than 5 minutes.
- It wrote at least 20,000 tokens to the cache.
- It wrote at least half of the previous turn's prompt size.

For a cold resume:

```
recached = min(tokens_written, previous_prompt_tokens)
idle = (recached / tokens_written) x write_cost - recached x cache_read_rate / 1,000,000
```

`write_cost` is the call's 5-minute and 1-hour writes at their own rates. The idle tax is the write price minus the read price the same tokens would have paid if the cache had stayed warm.

The report shows the number of resumes and the total tokens re-cached.

### Bloat and idle do not overlap

Bloat prices tokens above the cap at the read rate. Idle prices only the difference between write and read for re-cached tokens. A cold-resume turn over the cap is counted once at the read rate and once for the write premium, never twice at the same rate.

## Inheritance tax

### Finding the dispatch

Every `Agent` or `Task` tool call in any transcript is indexed by its `tool_use` id: its `model` input, its `subagent_type`, its `description` and the model of the assistant line that made the call (the dispatcher model). A run is linked to its dispatch through `meta.toolUseId`, or else through the `toolUseResult.agentId` on the user line that carries the result.

### Classification of subagent runs

A run's model is the model that accounts for most of its cost. Each run falls in one class.

| Class | When | Taxed |
| --- | --- | --- |
| `fork` | `agentType` is `fork`. Forks share the parent's model and cache by design. | No |
| `unattributed` | The dispatching call was not found, so nothing is assumed. | No |
| `pinned` | The call passed `model:` explicitly. | No |
| `inherited` | No `model:` on the call, and the run's model is the dispatcher's model. | Yes |
| `agent-default` | No `model:` on the call, but the agent definition or an env var chose a different model from the dispatcher's. | No |

A run is also only taxed if its model's family is more expensive than the target's (haiku < sonnet < opus < fable). A Sonnet run is never taxed when you reprice on Sonnet.

The report line "N of M subagent runs were dispatched without a model" is the `inherited` count out of all runs. `unpinned` in the JSON is `inherited` plus `agent-default`.

### Formula

For each taxed run:

```
tax = actual_cost - repriced_cost
```

`actual_cost` is what the run's calls cost, without the fast-mode premium. `repriced_cost` is the same token counts priced on the target model (Sonnet 5.5 by default, or Haiku 5.5 with `--as haiku`), with the US multiplier applied the same way and no fast factor. The tax is never negative.

The fast-mode premium is shown on its own line when it is not zero ("includes $X of fast-mode premium"). It is kept out of the tax so no dollar is counted twice.

## Totals and per-month figures

- Total spend is the sum of every priced, de-duplicated call in the window.
- The tax total is bloat + idle + inheritance.
- Shares are the tax divided by total spend.
- "At this rate: ~$X/month" is `(tax / days) x 30`, where `days` is the span from the first to the last call. It is only shown when there are at least 7 days of data.
- Session and project breakdowns add bloat and idle to the session's project. Inheritance goes to the run's project.

## The config audit

`auditConfig` reads `settings.json` in the user folder, `.claude/settings.json` and `.claude/settings.local.json` in the current directory, and custom agent files in `<claudeDir>/agents` and `.claude/agents`. It reports:

- custom agents with no `model:`, or `model: inherit`
- whether the guard hook or the plugin is installed
- `CLAUDE_CODE_SUBAGENT_MODEL` (bad if it names an Opus or Fable model, and bad on Claude Code before 2.1.251, where it overrides pinned agents)
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, which makes agent pins and the guard hook inert
- the auto-compact window (`autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, per-model settings), and whether auto-compact or idle compaction is turned off
- a main model of Opus or Fable (information only)

`fix` can only change what is marked fixable: unpinned agents, the missing guard hook, and the user-level `autoCompactWindow`. It never edits `env`, and it never turns auto-compact back on.

## What `fix` changes

1. `autoCompactWindow` in `<claudeDir>/settings.json`, set to the cap (default 200000, kept between 100,000 and 1,000,000). Skipped if it is already at or below that.
2. The guard: `hooks/guard.mjs` is copied to `<claudeDir>/fabletax/guard.mjs` and registered as a PreToolUse hook with matcher `Agent|Task`. Skipped if a fabletax hook or plugin is already present.
3. `model: <target>` in the frontmatter of each custom agent with no model. Nothing else in the file changes.

Before writing, every file is copied to `<claudeDir>/fabletax/backups/<timestamp>/` with a `manifest.json`. `settings.json` is written with the same indentation and file mode it had. If it is not valid JSON, `fix` refuses to touch it.

`fix --undo` restores the newest backup that has not been undone. Files that changed after the fix are not overwritten. In `settings.json` it removes only the hook entry and puts `autoCompactWindow` back to its previous value. A changed agent file is left alone and reported.

## The guard hook

`hooks/guard.mjs` is a PreToolUse hook with no imports from `src/`. It reads the tool call from stdin and stays silent unless all of this holds:

- The tool is `Agent` or `Task`, and `tool_input.model` is absent.
- `FABLETAX_GUARD` is not `off`, and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is not set.
- `subagent_type` is absent, `general-purpose` or `claude`, or it names a custom agent (project folder first, then user folder) whose frontmatter has no `model:` or says `inherit`.
- The dispatcher's model is known and from a pricier family than the target.

It never touches forks, plugin agents (`name:agent`), other built-in agent types, or any call with an explicit `model:`.

The target is `FABLETAX_MODEL`, else `--model=` on the command line, else `sonnet`. The dispatcher's model is the last assistant model in the final 256 KB of the transcript. The `api-request` line logged just before a dispatching turn counts too. When the call comes from a subagent, the subagent's own transcript is read. If the transcript has no model yet, the hook falls back to `model` in the settings files. If nothing is known, it stays silent rather than risk pinning upwards.

When it acts, it prints a hook decision of `allow` with `updatedInput` equal to the original input plus `model`, and appends `{ts, session_id, subagent_type, from, to}` to `<claudeDir>/fabletax/guard.log`. The prompt is never logged.

Any error makes the hook exit 0 with no output. It must never break a tool call.

Because the rule is "pricier than the target", `FABLETAX_MODEL=haiku` also pins calls dispatched from Sonnet.

## Known inaccuracies

- It is an estimate. Prices are list prices at the date in the table.
- On a subscription, figures are list-price value, not charges. The tool cannot tell plan allowance from usage credits.
- The transcript format is undocumented. A change between Claude Code versions can break parsing or classification. Lines that fail to parse are skipped.
- Transcripts are deleted after 30 days by default, so history is limited. Sessions that started before the window are seen from their first turn inside it, so the first in-window turn has nothing to compare against.
- The bloat tax assumes the work would have fit in 200k tokens. Compacting trades cost for memory, and some work needs the long context.
- The bloat tax prices excess tokens at the read rate, so it is a floor if they were billed as writes.
- The idle tax assumes the cache would have stayed warm. A large write after a pause can also come from changed context or a model switch, and would look like a cold resume.
- The inheritance tax assumes Sonnet 5.5 could do the job on the same tokens. A cheaper model may use more or fewer tokens, and some subagent work needs the big model.
- A run's model is the one that cost it most. A run that switched models is classed by that one.
- Subagent contexts get no bloat or idle tax.
- macOS and Linux only for now.
