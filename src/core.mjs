// core.mjs — transport-free logic for the `who` MCP server.
//
// Everything here is pure or takes an injected `fetch`, so the contract rows in
// test/ can drive it with a mocked fetch and never touch the network or a wallet.

export const BASE_URL = "https://lookups.alienprobe.ai/v1/lookup/who/";

// USDC on Base has 6 decimals. All on-the-wire amounts are integer base units.
export const USDC_DECIMALS = 6;
const UNITS_PER_USD = 10n ** BigInt(USDC_DECIMALS);

export const DEFAULT_MAX_USD_PER_CALL = 0.1;
export const DEFAULT_MAX_USD_PER_SESSION = 1.0;

export function unitsToUsd(units) {
  return Number(BigInt(units)) / Number(UNITS_PER_USD);
}

export function buildUrl(q) {
  return BASE_URL + encodeURIComponent(q);
}

/** Read and validate the spend caps out of an env-like object. */
export function readCaps(env = {}) {
  const parse = (raw, fallback, name) => {
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  return {
    perCallUsd: parse(env.MAX_USD_PER_CALL, DEFAULT_MAX_USD_PER_CALL, "MAX_USD_PER_CALL"),
    perSessionUsd: parse(env.MAX_USD_PER_SESSION, DEFAULT_MAX_USD_PER_SESSION, "MAX_USD_PER_SESSION")
  };
}

/** In-process spend ledger. One per server process = one "session". */
export function createLedger(caps) {
  let spentUsd = 0;
  let calls = 0;
  return {
    caps,
    get spentUsd() {
      return Number(spentUsd.toFixed(6));
    },
    get paidCalls() {
      return calls;
    },
    remainingUsd() {
      return Number((caps.perSessionUsd - spentUsd).toFixed(6));
    },
    /**
     * Decide whether an advertised price may be paid.
     * Returns null when allowed, or a structured refusal object.
     */
    check(priceUsd) {
      if (priceUsd > caps.perCallUsd) {
        return {
          error: "spend_cap_exceeded",
          scope: "per_call",
          price_usd: priceUsd,
          cap_usd: caps.perCallUsd,
          spent_usd_this_session: this.spentUsd,
          hint: "raise MAX_USD_PER_CALL in the MCP server config to authorize this price, or do not run this lookup"
        };
      }
      if (spentUsd + priceUsd > caps.perSessionUsd) {
        return {
          error: "spend_cap_exceeded",
          scope: "per_session",
          price_usd: priceUsd,
          cap_usd: caps.perSessionUsd,
          spent_usd_this_session: this.spentUsd,
          remaining_usd: this.remainingUsd(),
          hint: "the session budget is spent; raise MAX_USD_PER_SESSION and restart the MCP server to buy more"
        };
      }
      return null;
    },
    record(priceUsd) {
      spentUsd += priceUsd;
      calls += 1;
    }
  };
}

/** Pull the first advertised payment option out of a 402 body. */
export function readTerms(body) {
  const accept = Array.isArray(body?.accepts) ? body.accepts[0] : undefined;
  if (!accept) return null;
  const amount = String(accept.amount ?? accept.maxAmountRequired ?? "0");
  return {
    status: 402,
    paid: false,
    network: accept.network ?? null,
    scheme: accept.scheme ?? null,
    amount, // integer USDC base units, e.g. "50000"
    price_usd: unitsToUsd(amount),
    asset: accept.asset ?? null,
    pay_to: accept.payTo ?? null,
    max_timeout_seconds: accept.maxTimeoutSeconds ?? null,
    description: accept.description ?? null // carries the coverage statement
  };
}

/**
 * Map any upstream (status, body) pair onto the tool-result contract.
 * `paidUsd` is set only for a settled 200.
 */
export function mapResponse(status, body, paidUsd) {
  switch (status) {
    case 200:
      return { ...body, paid_usd: paidUsd ?? 0 };
    case 400:
      return { error: "invalid_subject", reason: body?.reason ?? null };
    case 404:
      return {
        error: "not_found",
        coverage: body?.coverage ?? body?.source?.coverage ?? body?.source ?? null
      };
    case 409:
      return {
        error: "ambiguous",
        candidates: body?.candidates ?? [],
        truncated: body?.truncated ?? false,
        hint:
          body?.hint ??
          "re-ask with the exact legal_name, then a ;jurisdiction suffix if it still collides"
      };
    case 503:
      return { error: "source_unavailable" };
    default:
      return {
        error: "unexpected_status",
        status,
        body: body ?? null
      };
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * `who_terms`: one plain, unwrapped fetch. No signer is constructed on this
 * path, so it cannot pay. A 402 yields the advertised terms; anything else is
 * a free refusal and is mapped the same way `who` would map it.
 */
export async function getTerms(q, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(buildUrl(q), { method: "GET" });
  const body = await readJson(res);
  if (res.status === 402) {
    const terms = readTerms(body);
    if (!terms) return { error: "source_unavailable", reason: "402 advertised no payment options" };
    return terms;
  }
  // A free refusal comes back in exactly the shape `who` would return it — same
  // keys, no extras — so a caller can hand either tool's output to the same
  // branch. Terms carry `status`/`paid`; refusals carry `error`. That is the
  // only difference, and it is enough to tell them apart.
  return mapResponse(res.status, body);
}

/**
 * `who`: preflight the price with a plain fetch, enforce the caps against the
 * advertised amount, and only then hand the URL to the payment-wrapped fetch.
 *
 * Two-phase on purpose: the preflight settles every free refusal (400/404/409/
 * 503) before a signer exists, and it gives the caps an exact number to judge
 * rather than a promise inside the payment library.
 *
 * `makePaidFetch` is injected so tests never construct a real wallet.
 */
export async function lookupWho(q, { ledger, fetchImpl = fetch, makePaidFetch, hasWallet }) {
  const url = buildUrl(q);

  // Phase 1 — free. Nothing here can pay.
  const probe = await fetchImpl(url, { method: "GET" });
  const probeBody = await readJson(probe);

  if (probe.status !== 402) {
    return { result: mapResponse(probe.status, probeBody), paid: false };
  }

  const terms = readTerms(probeBody);
  if (!terms) {
    return {
      result: { error: "source_unavailable", reason: "402 advertised no payment options" },
      paid: false
    };
  }

  // Phase 2 — guards, in order of how cheaply they can refuse.
  const capRefusal = ledger.check(terms.price_usd);
  if (capRefusal) return { result: capRefusal, paid: false };

  if (!hasWallet) {
    return {
      result: {
        error: "wallet_not_configured",
        price_usd: terms.price_usd,
        hint: "set PRIVATE_KEY in the MCP server's env to a throwaway Base wallet funded with a little USDC; who_terms works without it"
      },
      paid: false
    };
  }

  // Phase 3 — pay.
  let paidFetch;
  try {
    paidFetch = makePaidFetch();
  } catch (err) {
    return { result: { error: "wallet_invalid", reason: err?.message ?? String(err) }, paid: false };
  }

  let res;
  try {
    res = await paidFetch(url, { method: "GET" });
  } catch (err) {
    return {
      result: { error: "payment_failed", reason: err?.message ?? String(err) },
      paid: false
    };
  }

  const body = await readJson(res);

  if (res.status === 200) {
    ledger.record(terms.price_usd);
    return { result: mapResponse(200, body, terms.price_usd), paid: true };
  }

  // The upstream changed its mind between the probe and the retry (e.g. the
  // source went down). Nothing settled; map it like any other refusal.
  return { result: mapResponse(res.status, body), paid: false };
}
