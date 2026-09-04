#!/usr/bin/env node
// alienprobe-who-mcp — a stdio MCP server wrapping the paid `who` lookup.
//
//   who        one legal-entity fact, REAL MONEY ($0.05 USDC on Base)
//   who_terms  the advertised price and coverage, free, never pays
//
// Never write to stdout: stdout is the MCP JSON-RPC channel. Diagnostics go to
// stderr. PRIVATE_KEY is never logged, echoed, or returned in a tool result.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLedger, getTerms, lookupWho, readCaps } from "./core.mjs";

const PRICE_LABEL = "$0.05 USDC on Base mainnet";

let caps;
try {
  caps = readCaps(process.env);
} catch (err) {
  console.error(`alienprobe-who-mcp: ${err.message}`);
  process.exit(1);
}
const ledger = createLedger(caps);

/**
 * Build the payment-wrapped fetch. Deliberately lazy: the x402 and viem
 * modules are only imported, and the key only read, on a call that is already
 * cleared to pay. The server starts and serves who_terms with no key at all.
 */
async function loadPaymentFactory() {
  const { wrapFetchWithPaymentFromConfig } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");

  return () => {
    const raw = process.env.PRIVATE_KEY;
    const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
    return wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }]
    });
  };
}

function ok(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function fail(payload) {
  return { ...ok(payload), isError: true };
}

// Guard failures the caller can fix; upstream refusals are legitimate answers.
const GUARD_ERRORS = new Set([
  "spend_cap_exceeded",
  "wallet_not_configured",
  "wallet_invalid",
  "payment_failed",
  "source_unavailable",
  "unexpected_status",
  "transport_error"
]);

const server = new McpServer(
  { name: "alienprobe-who-mcp", version: "0.1.0" },
  {
    instructions:
      "Legal-entity identity lookups (LEI, legal name, jurisdiction, status) from GLEIF. " +
      `Call who_terms first — it is free. Calling who spends ${PRICE_LABEL} of the user's own funds.`
  }
);

server.registerTool(
  "who_terms",
  {
    title: "who: price and coverage (free)",
    description:
      "FREE, read-only. Returns the advertised x402 payment terms for a `who` lookup — price, " +
      "asset, network, payee, and the source's coverage statement — without paying anything and " +
      "without needing a wallet. Use this before `who` to decide whether the lookup is worth the " +
      `money (currently ${PRICE_LABEL}). If the subject is malformed, missing or ambiguous, this ` +
      "returns that free refusal instead of terms, which means `who` would also cost nothing.",
    inputSchema: {
      q: z
        .string()
        .min(1)
        .describe(
          "Company name, registrable domain (apple.com), or 20-character LEI. Append a " +
            'jurisdiction to disambiguate a name: "Acme Corp;US-DE".'
        )
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  async ({ q }) => {
    try {
      const terms = await getTerms(q);
      return terms.error && GUARD_ERRORS.has(terms.error) ? fail(terms) : ok(terms);
    } catch (err) {
      return fail({ error: "transport_error", reason: err?.message ?? String(err) });
    }
  }
);

server.registerTool(
  "who",
  {
    title: "who: paid legal-entity lookup",
    description:
      `SPENDS REAL MONEY: ${PRICE_LABEL} per successful answer, paid from the wallet in the ` +
      "server's PRIVATE_KEY env var. Not a subscription, not credits — an on-chain payment per " +
      "call. Check `who_terms` first if the price matters.\n\n" +
      "Returns exactly one GLEIF Level 1 record: LEI, legal name, jurisdiction, entity status, " +
      "registration status, last update, how it matched, and (domain queries only) the official " +
      "website. No addresses, no officers, no ownership graph, no guesses.\n\n" +
      "FREE refusals — these cost nothing and are returned as ordinary results:\n" +
      "  invalid_subject (malformed) | not_found (no match) | ambiguous (up to 5 candidates; " +
      "re-ask with an exact legal_name and a ;jurisdiction suffix) | source_unavailable.\n\n" +
      `Refuses without paying when the advertised price exceeds MAX_USD_PER_CALL (currently ` +
      `$${caps.perCallUsd.toFixed(2)}) or would exceed MAX_USD_PER_SESSION ` +
      `($${caps.perSessionUsd.toFixed(2)}).\n` +
      "Known gap: legal names that normalize to fewer than 2 Latin alphanumerics (CJK, Cyrillic, " +
      "Arabic, Hebrew, Thai...) are absent from this data vintage entirely.",
    inputSchema: {
      q: z
        .string()
        .min(1)
        .describe(
          "Company name, registrable domain (apple.com), or 20-character LEI. Append a " +
            'jurisdiction to disambiguate a name: "Acme Corp;US-DE". Subdomains do not match.'
        )
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  async ({ q }) => {
    try {
      const hasWallet = Boolean(process.env.PRIVATE_KEY);
      const makePaidFetch = hasWallet ? await loadPaymentFactory() : undefined;
      const { result } = await lookupWho(q, { ledger, hasWallet, makePaidFetch });
      return result.error && GUARD_ERRORS.has(result.error) ? fail(result) : ok(result);
    } catch (err) {
      return fail({ error: "transport_error", reason: err?.message ?? String(err) });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `alienprobe-who-mcp ready — caps $${caps.perCallUsd}/call, $${caps.perSessionUsd}/session; ` +
    `wallet ${process.env.PRIVATE_KEY ? "configured" : "NOT configured (who_terms only)"}`
);
