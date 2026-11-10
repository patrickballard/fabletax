# Contributing to fabletax

Thanks for helping. Keep changes small and focused.

## Ground rules

- Node.js 18 or newer. ES modules (`.mjs`) only.
- **Zero runtime dependencies is a hard rule.** Do not add an entry to
  `dependencies`. Use `node:` built-ins.
- No network access from the tool or its tests.
- Never log prompt or response text from transcripts. Report token counts and
  dollar figures only.

## Running tests

```sh
npm test
```

`npm test` runs `node --test`. Tests must never read the real `~/.claude`.
Point them at a fixture directory with `claudeDir` or `CLAUDE_CONFIG_DIR`.

## Prices

Every price lives in `src/prices.mjs`, with a date and a source URL. Dollar
figures are computed only from `src/cost.mjs` and that table. Do not add price
literals anywhere else. Tests may assert against table values.

A PR that changes a price must link the pricing page it was checked against.

## Adding a model to the price table

1. Open the pricing page and confirm the model id and per-million-token rates
   for input, output, and cache reads and writes.
2. Add an entry to `src/prices.mjs` with the model id, the rates, the `asOf`
   date, and the source URL.
3. Add or extend a test in `test/prices.test.mjs` that checks the new entry.
4. Note the pricing page link in the PR description.

## Testing the plugin locally

Load the working tree as a plugin without installing it:

```sh
claude --plugin-dir .
```

Then run the audit skill in that session and confirm the report renders.
