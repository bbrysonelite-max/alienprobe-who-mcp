// Contract rows for the refusal mapping and the spend caps.
// Every row runs against a mocked fetch: no network, no wallet, no payment.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createLedger,
  getTerms,
  lookupWho,
  mapResponse,
  readCaps,
  readTerms,
  unitsToUsd
} from "../src/core.mjs";

const TERMS_402 = {
  accepts: [
    {
      scheme: "exact",
      network: "base",
      amount: "50000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x701fd2Fc3295Ff2E98d986BD2032A966f54555f7",
      maxTimeoutSeconds: 60,
      description: "single-fact who lookup. Free: 400 malformed, 404 miss, 409 ambiguous, 503."
    }
  ]
};

const PAID_200 = {
  schema_version: "who-lookup.v1",
  subject: { type: "who", value: "apple.com" },
  answer: { lei: "HWUPKR0MPOU8FGXBT394", legal_name: "Apple Inc.", jurisdiction: "US-CA" }
};

/** A fetch stand-in that replays a fixed queue of (status, body) pairs. */
function mockFetch(...responses) {
  const queue = [...responses];
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error("mockFetch: no response queued");
    return { status: next.status, json: async () => next.body };
  };
  fn.calls = calls;
  return fn;
}

const freshLedger = (over = {}) =>
  createLedger({ perCallUsd: 0.1, perSessionUsd: 1.0, ...over });

// A paid fetch that must never be reached in the free rows.
const forbiddenPaidFetch = () => {
  throw new Error("payment path reached on a free row");
};

// ---------------------------------------------------------------- refusal map

const REFUSAL_ROWS = [
  {
    name: "400 -> invalid_subject with reason",
    status: 400,
    body: { error: "invalid_subject", reason: "empty" },
    expect: { error: "invalid_subject", reason: "empty" }
  },
  {
    name: "404 -> not_found with coverage",
    status: 404,
    body: { error: "not_found", coverage: "3283992 of 3419883, vintage 2026-09-03" },
    expect: { error: "not_found", coverage: "3283992 of 3419883, vintage 2026-09-03" }
  },
  {
    name: "404 -> not_found lifts coverage out of a nested source block",
    status: 404,
    body: { source: { name: "GLEIF", coverage: "all statuses" } },
    expect: { error: "not_found", coverage: "all statuses" }
  },
  {
    name: "409 -> ambiguous with candidates and hint",
    status: 409,
    body: {
      error: "ambiguous",
      candidates: [
        { legal_name: "ACME S.R.L.", jurisdiction: "IT" },
        { legal_name: "A.C.M.E. S.R.L.", jurisdiction: "IT" }
      ],
      truncated: true,
      hint: "re-ask with the exact legal_name, then a ;jurisdiction suffix if it still collides"
    },
    expect: {
      error: "ambiguous",
      candidates: [
        { legal_name: "ACME S.R.L.", jurisdiction: "IT" },
        { legal_name: "A.C.M.E. S.R.L.", jurisdiction: "IT" }
      ],
      truncated: true,
      hint: "re-ask with the exact legal_name, then a ;jurisdiction suffix if it still collides"
    }
  },
  {
    name: "409 -> ambiguous supplies the re-ask hint when upstream omits it",
    status: 409,
    body: { error: "ambiguous", candidates: [] },
    expect: {
      error: "ambiguous",
      candidates: [],
      truncated: false,
      hint: "re-ask with the exact legal_name, then a ;jurisdiction suffix if it still collides"
    }
  },
  {
    name: "503 -> source_unavailable, no upstream detail leaked",
    status: 503,
    body: { error: "whatever", internal: "stack trace" },
    expect: { error: "source_unavailable" }
  }
];

for (const row of REFUSAL_ROWS) {
  test(`mapResponse: ${row.name}`, () => {
    assert.deepEqual(mapResponse(row.status, row.body), row.expect);
  });

  test(`who: ${row.name} costs nothing and never reaches the payment path`, async () => {
    const ledger = freshLedger();
    const { result, paid } = await lookupWho("subject", {
      ledger,
      fetchImpl: mockFetch({ status: row.status, body: row.body }),
      hasWallet: true,
      makePaidFetch: forbiddenPaidFetch
    });
    assert.deepEqual(result, row.expect);
    assert.equal(paid, false);
    assert.equal(ledger.spentUsd, 0);
    assert.equal(ledger.paidCalls, 0);
  });
}

test("mapResponse: an unexpected status is surfaced, not swallowed", () => {
  assert.deepEqual(mapResponse(418, { hi: 1 }), {
    error: "unexpected_status",
    status: 418,
    body: { hi: 1 }
  });
});

test("200 -> the body verbatim plus paid_usd", () => {
  const mapped = mapResponse(200, PAID_200, 0.05);
  assert.deepEqual({ ...mapped, paid_usd: undefined }, { ...PAID_200, paid_usd: undefined });
  assert.equal(mapped.paid_usd, 0.05);
});

// ---------------------------------------------------------------------- terms

test("readTerms: 50000 base units is $0.05", () => {
  const terms = readTerms(TERMS_402);
  assert.equal(terms.amount, "50000");
  assert.equal(terms.price_usd, 0.05);
  assert.equal(terms.network, "base");
  assert.equal(terms.paid, false);
  assert.equal(unitsToUsd("50000"), 0.05);
});

test("who_terms: a 402 yields terms and never pays", async () => {
  const fetchImpl = mockFetch({ status: 402, body: TERMS_402 });
  const terms = await getTerms("apple.com", { fetchImpl });
  assert.equal(terms.amount, "50000");
  assert.equal(terms.price_usd, 0.05);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0], /\/v1\/lookup\/who\/apple\.com$/);
});

test("who_terms: a free refusal is returned in place of terms", async () => {
  const terms = await getTerms("Acme", {
    fetchImpl: mockFetch({ status: 409, body: { candidates: [] } })
  });
  assert.equal(terms.error, "ambiguous");
  // Refusals carry no `paid`/`status` decoration — see the identical-shape rows.
  assert.equal("paid" in terms, false);
  assert.equal("status" in terms, false);
});

// A caller must be able to hand either tool's refusal to the same branch.
for (const row of REFUSAL_ROWS) {
  test(`who_terms and who return an identical shape for: ${row.name}`, async () => {
    const fixture = () => mockFetch({ status: row.status, body: row.body });
    const fromTerms = await getTerms("subject", { fetchImpl: fixture() });
    const { result: fromWho } = await lookupWho("subject", {
      ledger: freshLedger(),
      fetchImpl: fixture(),
      hasWallet: true,
      makePaidFetch: forbiddenPaidFetch
    });
    assert.deepEqual(fromTerms, fromWho);
    assert.deepEqual(fromTerms, row.expect);
  });
}

test("who_terms: a ;jurisdiction suffix is URL-encoded, not split", async () => {
  const fetchImpl = mockFetch({ status: 402, body: TERMS_402 });
  await getTerms("ACME S.R.L.;IT", { fetchImpl });
  assert.match(fetchImpl.calls[0], /ACME%20S\.R\.L\.%3BIT$/);
});

// ----------------------------------------------------------------- spend caps

test("readCaps: defaults are $0.10/call and $1.00/session", () => {
  assert.deepEqual(readCaps({}), { perCallUsd: 0.1, perSessionUsd: 1.0 });
});

test("readCaps: env overrides both caps", () => {
  assert.deepEqual(readCaps({ MAX_USD_PER_CALL: "0.02", MAX_USD_PER_SESSION: "0.25" }), {
    perCallUsd: 0.02,
    perSessionUsd: 0.25
  });
});

test("readCaps: a garbage cap is a startup error, not a silent default", () => {
  assert.throws(() => readCaps({ MAX_USD_PER_CALL: "free" }), /MAX_USD_PER_CALL/);
  assert.throws(() => readCaps({ MAX_USD_PER_SESSION: "-1" }), /MAX_USD_PER_SESSION/);
});

test("cap: a price over MAX_USD_PER_CALL refuses without paying", async () => {
  const ledger = freshLedger({ perCallUsd: 0.01 });
  const { result, paid } = await lookupWho("apple.com", {
    ledger,
    fetchImpl: mockFetch({ status: 402, body: TERMS_402 }),
    hasWallet: true,
    makePaidFetch: forbiddenPaidFetch
  });
  assert.equal(result.error, "spend_cap_exceeded");
  assert.equal(result.scope, "per_call");
  assert.equal(result.price_usd, 0.05);
  assert.equal(result.cap_usd, 0.01);
  assert.ok(result.hint.includes("MAX_USD_PER_CALL"));
  assert.equal(paid, false);
  assert.equal(ledger.spentUsd, 0);
});

test("cap: the session budget is spent down and then refuses", async () => {
  const ledger = freshLedger({ perSessionUsd: 0.12 }); // room for exactly two $0.05 calls
  const fetchImpl = mockFetch({ status: 402, body: TERMS_402 });
  const makePaidFetch = () => async () => ({ status: 200, json: async () => PAID_200 });
  const run = () => lookupWho("apple.com", { ledger, fetchImpl, hasWallet: true, makePaidFetch });

  const first = await run();
  assert.equal(first.paid, true);
  assert.equal(first.result.paid_usd, 0.05);
  assert.equal(first.result.answer.lei, "HWUPKR0MPOU8FGXBT394");
  assert.equal(ledger.spentUsd, 0.05);

  const second = await run();
  assert.equal(second.paid, true);
  assert.equal(ledger.spentUsd, 0.1);
  assert.equal(ledger.paidCalls, 2);

  const third = await run(); // 0.10 + 0.05 > 0.12
  assert.equal(third.paid, false);
  assert.equal(third.result.error, "spend_cap_exceeded");
  assert.equal(third.result.scope, "per_session");
  assert.equal(third.result.remaining_usd, 0.02);
  assert.equal(ledger.spentUsd, 0.1, "a refused call must not move the ledger");
  assert.equal(ledger.paidCalls, 2);
});

// -------------------------------------------------------------------- wallet

test("who: no wallet refuses after the caps, and only on a real 402", async () => {
  const ledger = freshLedger();
  const { result, paid } = await lookupWho("apple.com", {
    ledger,
    fetchImpl: mockFetch({ status: 402, body: TERMS_402 }),
    hasWallet: false,
    makePaidFetch: forbiddenPaidFetch
  });
  assert.equal(result.error, "wallet_not_configured");
  assert.equal(result.price_usd, 0.05);
  assert.ok(result.hint.includes("PRIVATE_KEY"));
  assert.equal(paid, false);
});

test("who: a free refusal still answers with no wallet at all", async () => {
  const { result } = await lookupWho(" ", {
    ledger: freshLedger(),
    fetchImpl: mockFetch({ status: 400, body: { reason: "empty" } }),
    hasWallet: false,
    makePaidFetch: forbiddenPaidFetch
  });
  assert.deepEqual(result, { error: "invalid_subject", reason: "empty" });
});

test("who: a thrown payment is a structured result, not an exception", async () => {
  const ledger = freshLedger();
  const { result, paid } = await lookupWho("apple.com", {
    ledger,
    fetchImpl: mockFetch({ status: 402, body: TERMS_402 }),
    hasWallet: true,
    makePaidFetch: () => async () => {
      throw new Error("insufficient USDC balance");
    }
  });
  assert.equal(result.error, "payment_failed");
  assert.match(result.reason, /insufficient USDC/);
  assert.equal(paid, false);
  assert.equal(ledger.spentUsd, 0);
});

test("who: an upstream that flips 402 -> 503 on the retry charges nothing", async () => {
  const ledger = freshLedger();
  const { result, paid } = await lookupWho("apple.com", {
    ledger,
    fetchImpl: mockFetch({ status: 402, body: TERMS_402 }),
    hasWallet: true,
    makePaidFetch: () => async () => ({ status: 503, json: async () => ({}) })
  });
  assert.deepEqual(result, { error: "source_unavailable" });
  assert.equal(paid, false);
  assert.equal(ledger.spentUsd, 0);
});

test("who: a 402 advertising no options is refused, not paid", async () => {
  const { result, paid } = await lookupWho("apple.com", {
    ledger: freshLedger(),
    fetchImpl: mockFetch({ status: 402, body: { accepts: [] } }),
    hasWallet: true,
    makePaidFetch: forbiddenPaidFetch
  });
  assert.equal(result.error, "source_unavailable");
  assert.equal(paid, false);
});
