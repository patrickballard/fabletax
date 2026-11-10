import { costOf, emptyUsage, addUsage, promptTokens, ratesFor } from './cost.mjs';
import { PRICES_AS_OF, familyOf, rankOf, resolveModel, resolveTarget } from './prices.mjs';

const DAY_MS = 86_400_000;

// How a subagent run got its model. Only `inherited` is ever taxed.
//   fork          forks always share the parent's model and cache, by design
//   unattributed  the dispatching Agent call was not found, so we do not guess
//   pinned        the Agent call passed `model:` explicitly
//   inherited     no `model:` on the call and the run used the dispatcher's model
//   agent-default no `model:` on the call, but the agent definition or an env
//                 var chose a different model than the dispatcher's
export function classifyRun(meta, model) {
  if (meta?.agentType === 'fork') return 'fork';
  const d = meta?.dispatch;
  if (!d?.found) return 'unattributed';
  if (d.model) return 'pinned';
  const same = (resolveModel(d.dispatcherModel) || d.dispatcherModel) === (resolveModel(model) || model);
  return same ? 'inherited' : 'agent-default';
}

export const DEFAULT_CONTEXT_CAP = 200_000;
// A resume counts as cold when it follows a gap longer than the shortest
// cache TTL and writes back at least half of the previous prompt.
const IDLE_GAP_MS = 5 * 60_000;
const MIN_RECACHE_TOKENS = 20_000;

// Bloat and idle tax for the main thread of each session. Together they are
// what the session cost above a "warm and capped" version of itself:
//   bloat  tokens carried beyond `cap` on a turn, at the cache-read rate (the
//          cheapest those tokens could have been billed)
//   idle   context that was already cached, written again after the cache
//          expired: the write price minus the read price it would have paid
// The two never price the same token twice.
export function contextTaxes(mainBySession, cap) {
  const bloat = { usd: 0, calls: 0, capTokens: cap, peakTokens: 0 };
  const idle = { usd: 0, resumes: 0, tokens: 0 };
  const sessions = [];
  for (const turns of mainBySession.values()) {
    turns.sort((a, b) => a.ts - b.ts);
    const s = { project: turns[0].project, ts: turns[0].ts, turns: turns.length, usd: 0, bloatUsd: 0, idleUsd: 0, peakTokens: 0, resumes: 0 };
    let prev = null;
    for (const t of turns) {
      const rates = ratesFor(t.usage, t.key);
      const prompt = promptTokens(t.usage);
      s.usd += t.usd;
      if (prompt > s.peakTokens) s.peakTokens = prompt;
      if (prompt > cap) {
        s.bloatUsd += ((prompt - cap) * rates.cacheRead) / 1e6;
        bloat.calls += 1;
      }
      const written = t.usage.cacheWrite5m + t.usage.cacheWrite1h;
      if (prev && t.ts - prev.ts > IDLE_GAP_MS && written >= MIN_RECACHE_TOKENS && written >= 0.5 * prev.prompt) {
        const recached = Math.min(written, prev.prompt);
        const writeUsd = (t.usage.cacheWrite5m * rates.cacheWrite5m + t.usage.cacheWrite1h * rates.cacheWrite1h) / 1e6;
        s.idleUsd += (recached / written) * writeUsd - (recached * rates.cacheRead) / 1e6;
        s.resumes += 1;
        idle.tokens += recached;
      }
      prev = { ts: t.ts, prompt };
    }
    bloat.usd += s.bloatUsd;
    idle.usd += s.idleUsd;
    idle.resumes += s.resumes;
    if (s.peakTokens > bloat.peakTokens) bloat.peakTokens = s.peakTokens;
    sessions.push(s);
  }
  return { bloat, idle, sessions };
}

const bucket = () => ({ usd: 0, calls: 0 });
const bump = (b, usd) => { b.usd += usd; b.calls += 1; };
const upsert = (map, key, make) => map.get(key) || map.set(key, make()).get(key);
const byUsdDesc = (a, b) => b.usd - a.usd;

// calls:  de-duplicated billable API calls (shapes are in docs/HOW-IT-WORKS.md)
// agents: Map<agentKey, AgentRun> describing each subagent run's dispatch
//
// The inheritance tax of a run is what it cost minus what the same tokens
// would have cost on `target`, counted only for runs that inherited a model
// from a more expensive family than `target`.
export function analyze({ calls, agents }, { target = 'sonnet', cap = DEFAULT_CONTEXT_CAP, now = Date.now() } = {}) {
  const targetModel = resolveTarget(target);
  const targetRank = rankOf(targetModel);
  const mainBySession = new Map();

  const total = { ...bucket(), usage: emptyUsage() };
  const main = bucket();
  const sub = bucket();
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const runs = new Map();
  const unpriced = { calls: 0, models: {} };
  let fastPremiumUsd = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const call of calls) {
    const cost = costOf(call.usage, call.model, { speed: call.speed, geo: call.geo });
    if (!cost.priced) {
      unpriced.calls += 1;
      unpriced.models[call.model] = (unpriced.models[call.model] || 0) + 1;
      continue;
    }
    const usd = cost.usd;
    if (call.ts < firstTs) firstTs = call.ts;
    if (call.ts > lastTs) lastTs = call.ts;

    bump(total, usd);
    addUsage(total.usage, call.usage);
    const m = upsert(byModel, cost.key, () => ({ model: cost.key, family: familyOf(cost.key), ...bucket(), usage: emptyUsage() }));
    bump(m, usd);
    addUsage(m.usage, call.usage);
    bump(upsert(byProject, call.project, () => ({ project: call.project, ...bucket(), taxUsd: 0 })), usd);
    const day = new Date(call.ts).toISOString().slice(0, 10);
    bump(upsert(byDay, day, () => ({ day, ...bucket(), taxUsd: 0 })), usd);
    // The fast-mode premium is reported on its own line and kept out of the
    // tax, so the two figures never count the same dollar twice.
    const standardUsd = call.speed === 'fast' ? costOf(call.usage, call.model, { geo: call.geo }).usd : usd;
    fastPremiumUsd += usd - standardUsd;

    if (!call.agentKey) {
      bump(main, usd);
      upsert(mainBySession, call.sessionId, () => []).push({
        ts: call.ts, usage: call.usage, key: cost.key, usd, project: call.project,
      });
      continue;
    }
    bump(sub, usd);
    const run = upsert(runs, call.agentKey, () => ({
      key: call.agentKey, project: call.project, ts: call.ts, ...bucket(), standardUsd: 0, repricedUsd: 0, models: new Map(),
    }));
    bump(run, usd);
    run.standardUsd += standardUsd;
    if (call.ts < run.ts) run.ts = call.ts;
    run.repricedUsd += costOf(call.usage, targetModel, { geo: call.geo }).usd;
    run.models.set(cost.key, (run.models.get(cost.key) || 0) + usd);
  }

  const byClass = {};
  const byAgentType = new Map();
  const taxed = [];
  const tax = { usd: 0, runs: 0, actualUsd: 0, repricedUsd: 0 };

  for (const run of runs.values()) {
    const meta = agents.get(run.key);
    const model = [...run.models].sort((a, b) => b[1] - a[1])[0][0];
    const cls = classifyRun(meta, model);
    const c = (byClass[cls] ||= { runs: 0, usd: 0 });
    c.runs += 1;
    c.usd += run.usd;

    if (cls !== 'inherited' || rankOf(model) <= targetRank) continue;
    const taxUsd = Math.max(0, run.standardUsd - run.repricedUsd);
    tax.usd += taxUsd;
    tax.runs += 1;
    tax.actualUsd += run.standardUsd;
    tax.repricedUsd += run.repricedUsd;
    byProject.get(run.project).taxUsd += taxUsd;
    byDay.get(new Date(run.ts).toISOString().slice(0, 10)).taxUsd += taxUsd;
    const agentType = meta.agentType || 'unknown';
    const t = upsert(byAgentType, agentType, () => ({ agentType, runs: 0, usd: 0, taxUsd: 0 }));
    t.runs += 1;
    t.usd += run.standardUsd;
    t.taxUsd += taxUsd;
    taxed.push({
      agentType, description: meta.description || '', model, project: run.project, ts: run.ts,
      calls: run.calls, usd: run.standardUsd, repricedUsd: run.repricedUsd, taxUsd,
    });
  }

  const { bloat, idle, sessions } = contextTaxes(mainBySession, cap);
  for (const s of sessions) {
    const contextTax = s.bloatUsd + s.idleUsd;
    if (!contextTax) continue;
    byProject.get(s.project).taxUsd += contextTax;
    byDay.get(new Date(s.ts).toISOString().slice(0, 10)).taxUsd += contextTax;
  }

  const hasData = total.calls > 0;
  const days = hasData ? Math.max(1, (lastTs - firstTs) / DAY_MS) : 0;
  const count = (cls) => byClass[cls]?.runs || 0;
  const share = (usd) => (total.usd > 0 ? usd / total.usd : 0);
  const taxTotalUsd = bloat.usd + idle.usd + tax.usd;

  return {
    generatedAt: now,
    pricesAsOf: PRICES_AS_OF,
    target: { alias: target, model: targetModel },
    window: { from: hasData ? firstTs : null, to: hasData ? lastTs : null, days },
    total,
    main,
    subagents: { ...sub, runs: runs.size, byClass },
    dispatch: {
      runs: runs.size,
      unpinned: count('inherited') + count('agent-default'),
      inherited: count('inherited'),
      taxed: tax.runs,
    },
    // `tax` is the inheritance tax; `bloat` and `idle` are the two context
    // taxes; `taxTotal` is the three added together.
    tax: {
      ...tax,
      shareOfTotal: share(tax.usd),
      // A run-rate is only shown once there is a week of data behind it.
      perMonthUsd: days >= 7 ? (tax.usd / days) * 30 : null,
    },
    bloat: { ...bloat, shareOfTotal: share(bloat.usd) },
    idle: { ...idle, shareOfTotal: share(idle.usd) },
    taxTotal: {
      usd: taxTotalUsd,
      shareOfTotal: share(taxTotalUsd),
      perMonthUsd: days >= 7 ? (taxTotalUsd / days) * 30 : null,
    },
    topSessions: sessions
      .filter((s) => s.bloatUsd + s.idleUsd > 0)
      .sort((a, b) => b.bloatUsd + b.idleUsd - (a.bloatUsd + a.idleUsd))
      .slice(0, 5),
    byModel: [...byModel.values()].sort(byUsdDesc),
    byProject: [...byProject.values()].sort(byUsdDesc),
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    byAgentType: [...byAgentType.values()].sort((a, b) => b.taxUsd - a.taxUsd),
    topRuns: taxed.sort((a, b) => b.taxUsd - a.taxUsd).slice(0, 10),
    fastPremiumUsd,
    unpriced,
  };
}
