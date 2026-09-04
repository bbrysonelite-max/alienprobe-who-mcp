# alienprobe-who-mcp

An MCP server that gives any agent one legal-entity fact — LEI, legal name, jurisdiction, entity and registration status — for **$0.05 USDC on Base**, paid per call over [x402](https://github.com/x402-foundation/x402). No signup, no API key, no account. The wallet is the account.

Two tools:

| Tool | Cost | What it does |
|---|---|---|
| `who_terms` | **free** | Returns the advertised price, network, payee and coverage. Never pays. Works with no wallet. |
| `who` | **$0.05, real money** | Returns the entity record. Misses and ambiguities cost nothing. |

## Client config

Three lines. Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "who": { "command": "npx", "args": ["-y", "@alienprobe/who-mcp"],
  "env": { "PRIVATE_KEY": "0x...", "MAX_USD_PER_SESSION": "1.00" } } } }
```

Drop the `env` block entirely and the server still starts — `who_terms` works, `who` refuses with `wallet_not_configured`. That is the safe way to try it.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `PRIVATE_KEY` | *(none)* | A **throwaway** Base-mainnet wallet holding a little USDC. Optional. Never logged, echoed, or returned in a tool result. |
| `MAX_USD_PER_CALL` | `0.10` | Hard ceiling on one lookup. The lookup is advertised at $0.05. |
| `MAX_USD_PER_SESSION` | `1.00` | Hard ceiling on everything this server process spends before restart. |

See `.env.example`. Never commit a real key. Fund a wallet that holds nothing else — about $1 of USDC covers 20 lookups. This repo does not tell you how to get USDC onto Base; see https://docs.base.org/base-chain/tools/bridges/.

## Spend caps

The server preflights every `who` call with a plain, unwrapped `fetch` — no signer exists on that path — reads the advertised price out of the 402, and only then decides. If the price exceeds `MAX_USD_PER_CALL`, or would push the running total past `MAX_USD_PER_SESSION`, it refuses with a result the model can read and act on:

```json
{
  "error": "spend_cap_exceeded",
  "scope": "per_session",
  "price_usd": 0.05,
  "cap_usd": 1.0,
  "spent_usd_this_session": 1.0,
  "remaining_usd": 0.0,
  "hint": "the session budget is spent; raise MAX_USD_PER_SESSION and restart the MCP server to buy more"
}
```

A session is one server process. Restarting the client resets the counter, so the per-session cap is a brake, not a ledger — the wallet balance is the real ceiling. Keep it small.

## What comes back

A paid hit is the API's body verbatim plus `paid_usd`:

```json
{
  "schema_version": "who-lookup.v1",
  "subject": { "type": "who", "value": "apple.com" },
  "answer": {
    "lei": "HWUPKR0MPOU8FGXBT394",
    "legal_name": "Apple Inc.",
    "jurisdiction": "US-CA",
    "entity_status": "ACTIVE",
    "registration_status": "ISSUED",
    "match": { "by": "domain", "rule": "domain_exact" },
    "official_website": "https://apple.com/"
  },
  "source": { "name": "...", "vintage": "...", "coverage": "..." },
  "paid_usd": 0.05
}
```

`q` is a company name, a registrable domain, or a 20-character LEI. To disambiguate a name, append a jurisdiction in the same string: `"Acme Corp;US-DE"`.

### `paid_usd` is the authorized price, not the receipt

`paid_usd` is the amount the server *authorized* — the price the API advertised in its 402 and that the spend caps were judged against. It is not read back from the chain.

One case where it overstates: **a wallet's first successful lookup on this pricing shelf settles at $0** (first-can-free; a property of the service, not of this client). That call still reports `"paid_usd": 0.05`. Every subsequent call actually moves $0.05.

The server's session counter inherits the same overstatement, which is the safe direction — it stops you early, never late. If you need the truth, the on-chain USDC `Transfer` from your wallet is the only receipt. Do not use `paid_usd` for accounting.

## Free refusals

These never pay, and they come back as ordinary tool results the model can reason about — not exceptions:

| Upstream | Result |
|---|---|
| `400` | `{"error":"invalid_subject","reason":"empty"}` |
| `404` | `{"error":"not_found","coverage":"..."}` |
| `409` | `{"error":"ambiguous","candidates":[...],"hint":"re-ask with the exact legal_name, then a ;jurisdiction suffix if it still collides"}` |
| `503` | `{"error":"source_unavailable"}` |

The API only charges once it can commit to one entity, so an ambiguous re-ask is still free while it stays ambiguous.

## What this does not do

- No street addresses, no officers or directors, no ownership graph.
- No guessing. A miss is a `404`, not a best-effort answer.
- Legal names that normalize to fewer than 2 Latin alphanumerics (CJK, Cyrillic, Greek, Arabic, Hebrew, Thai) are absent from this data vintage entirely — every door, not just the name door.
- Domains match only where the source links an LEI to an official website, on the exact registrable domain. A subdomain misses.

## Development

```bash
npm install
npm test     # 28 contract rows over a mocked fetch: no network, no wallet, no payment
npm run smoke  # spawns the server, drives initialize/tools/list/who_terms over real stdio
```

`npm run smoke` hits the live endpoint to fetch the 402. It runs with `PRIVATE_KEY` blank and asserts the advertised `amount` is `"50000"` ($0.05). It cannot pay.

`src/core.mjs` holds the transport-free logic and takes an injected `fetch`, which is why the tests never need a wallet. `src/index.mjs` is only the MCP wiring; `@x402/*` and `viem` are imported lazily, on a call already cleared to pay.

Built on [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) 1.30.0. See `SPEC.md` for the full contract and the distribution plan.

## License

MIT © Brent Bryson. See `LICENSE`.
