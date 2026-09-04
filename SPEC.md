# alienprobe-who-mcp — spec

Wrap the paid `who` lookup (`GET https://lookups.alienprobe.ai/v1/lookup/who/{q}`, x402 on Base) so any MCP client calls it as one tool. Buyer mechanics proven in `who-in-60-seconds`; only the surface is new.

## Package and runtime

`alienprobe-who-mcp`, MIT, Brent Bryson. stdio only. Plain ESM `.mjs`, runs under bare `node`, no build step.

SDK: `@modelcontextprotocol/sdk@1.30.0` (npm `latest`, 2026-07-27). API as shipped: `new McpServer({name, version}, {instructions})` from `.../server/mcp.js`; `StdioServerTransport` from `.../server/stdio.js`; tools via `server.registerTool(name, {title, description, inputSchema, annotations}, handler)` — `server.tool()` is `@deprecated` in the shipped `.d.ts`. `inputSchema` is a **raw Zod shape** (`{ q: z.string() }`), not a `z.object`. Peer `zod` pinned 4.5.4. No `outputSchema`, so `structuredContent` passes through unvalidated; every result carries both JSON text and `structuredContent`.

Deferred: `@modelcontextprotocol/server@2.0.0` is the v2 SDK, renamed. Client support is not yet broad; revisit when Claude Desktop requires it.

## Tools

**`who_terms({ q })`** — free, `readOnlyHint: true`. One plain unwrapped `fetch`; no signer exists on this path, so it cannot pay. A `402` returns `{status, network, scheme, amount, price_usd, asset, pay_to, max_timeout_seconds, description, paid:false}`; `amount` is integer USDC base units (`"50000"` = $0.05) and `description` carries the vintage/coverage statement. Any non-402 is a free refusal, returned in place of terms in byte-identical shape to `who`'s (same keys, no extras) — so `who_terms` also answers "this would cost nothing," and one branch handles either tool.

**`who({ q })`** — paid. `q` is a company name, registrable domain, or 20-char LEI. The `;jurisdiction` re-ask is the caller's job: they pass `Acme Corp;US-DE` as one string, which the server URL-encodes whole.

Both descriptions state the price, that it is **real money** per call rather than credits, and name the four free refusals. `who`'s also states the caps in force and the non-Latin-name gap.

## Payment path

Two-phase, on purpose:

1. **Preflight** — plain `fetch`. Settles every free refusal before a signer exists, and hands the caps an exact number instead of a promise inside the payment library.
2. **Guards** — caps, then wallet.
3. **Pay** — `@x402/fetch@2.25.0` `wrapFetchWithPaymentFromConfig` + `@x402/evm` `ExactEvmScheme` + `viem` `privateKeyToAccount`, network `eip155:8453`. The library does the whole 402 → sign → retry → 200 dance; no header is built by hand.

`@x402/*` and `viem` are imported lazily, only on a call already cleared to pay.

## Wallet

`PRIVATE_KEY` env. Never logged, echoed, or returned. The server **starts without it** and serves `who_terms`; only `who` refuses, and only after the caps and only on a real 402 — a free refusal still answers with no wallet.

## Spend caps

`MAX_USD_PER_CALL` (default 0.10) and `MAX_USD_PER_SESSION` (default 1.00), enforced in-process against the advertised price. A session is one server process. A malformed cap is a startup exit, not a silent default. A refused call never moves the ledger.

## Result contract

Refusals are tool results, never exceptions.

| Upstream | Result |
|---|---|
| 400 | `{error:"invalid_subject", reason}` |
| 404 | `{error:"not_found", coverage}` |
| 409 | `{error:"ambiguous", candidates, truncated, hint}` |
| 503 | `{error:"source_unavailable"}` |
| 200 | the JSON body **verbatim** plus `{paid_usd}` |

Guards add `spend_cap_exceeded` (`scope`, `price_usd`, `cap_usd`, `spent_usd_this_session`, `hint`), `wallet_not_configured`, `wallet_invalid`, `payment_failed`, `unexpected_status`, `transport_error`. Guards and `source_unavailable` set `isError: true`; 400/404/409 do not — a miss is a legitimate answer, not a fault.

`paid_usd` is the **authorized** advertised price, not read back from chain. First-can-free means a wallet's first settlement is $0, so `paid_usd` overstates that one call and the session counter inherits it. Accepted — it errs early, never late. Disclosed in the README; the on-chain `Transfer` is the receipt.

## Client config

Three lines in `claude_desktop_config.json` or Cursor's `mcp.json`:

```json
{ "mcpServers": { "who": { "command": "npx", "args": ["-y", "alienprobe-who-mcp"],
  "env": { "PRIVATE_KEY": "0x...", "MAX_USD_PER_SESSION": "1.00" } } } }
```

## Distribution

Order matters: the official registry feeds the aggregators.

1. **npm** — `npm publish --access public`, unscoped `alienprobe-who-mcp`, so `npx alienprobe-who-mcp` works. Set already: `"mcpName": "io.github.bbrysonelite-max/alienprobe-who-mcp"` plus `repository`/`homepage`; the registry verifies ownership through `mcpName`.
2. **Official MCP Registry** — `brew install mcp-publisher` (or the tarball at `github.com/modelcontextprotocol/registry/releases/latest`), then `mcp-publisher init` → edit `server.json` (`registryType:"npm"`, `transport:{type:"stdio"}`, `PRIVATE_KEY` as `isSecret`) → `login github` → `publish`. Docs: https://github.com/modelcontextprotocol/registry, docs/modelcontextprotocol-io/quickstart.mdx.
3. **PulseMCP** — https://www.pulsemcp.com/submit. Direct submissions are **paused**; the page says listings are picked up automatically from the official registry, "the best first step even when we are not paused." Step 2 is the whole action.
4. **Glama** — https://glama.ai/mcp/servers, "Add MCP Server": repo URL + name + description, GitHub OAuth, submitter must hold write/admin on the repo. Automated license/security/health checks pass in minutes. Optional `glama.json` steers indexing.
5. **Smithery** — https://smithery.ai/new, or the CLI (https://github.com/smithery-ai/cli). Smithery hosting is not required; a local server ships as an `.mcpb` bundle: `smithery mcp publish ./server.mcpb -n bbrysonelite-max/alienprobe-who-mcp`.
6. **mcp.so** — https://mcp.so/submit. Public GitHub repos only; complete the draft after submitting, and saving publishes it.

## Tests

`node --test` — 34 contract rows over a mocked fetch: every refusal status mapped, proven not to reach the payment path, and proven byte-identical between the two tools; per-call and per-session caps including spend-down and ledger immutability on refusal; cap parsing; `;jurisdiction` encoding; no-wallet behaviour; thrown-payment and 402→503-flip rows. Plus `test/smoke.mjs`: spawns the server with no wallet and drives `initialize` / `tools/list` / `tools/call who_terms {q:"apple.com"}` over real stdio against the **live** 402, asserting `amount === "50000"`. Nothing can pay.

## Kill criterion

Zero paid calls through the MCP in the 30 days after the last listing goes live. Then unlist, and stop.
