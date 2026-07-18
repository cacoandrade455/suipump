// price_publisher.js - SuiPump protocol price reference publisher (V13)
//
// Publishes the SUI/USD reference that bonding_curve::buy() reads to compute the
// dampened graduation threshold. Replaces V9's caller-supplied sui_price_scaled
// (audit F-2: a caller passing an inflated price collapsed the threshold and
// bricked a fresh curve for ~3 SUI).
//
// CONTRACT COUPLING - keep these in sync with bonding_curve.move:
//   MIN_PRICE_SCALED      = 100      ($0.10)   set_sui_price aborts below
//   MAX_PRICE_SCALED      = 100_000  ($100)    set_sui_price aborts above
//   PRICE_MAX_AGE_MS      = 30 min             buy() ignores older, falls back
//                                              to BASE_GRAD_MIST (9,000 SUI)
// Push cadence is 5 min, so the contract tolerates ~5 consecutive failed pushes
// before the dampener degrades. Degradation is SAFE: buy() never aborts on a
// stale price, it just graduates at the static 9,000 SUI threshold.
//
// FAILURE PHILOSOPHY: never push a number we are not confident in. A stale price
// is a degraded dampener; a WRONG price moves every curve's graduation target.
// When in doubt, do not push.
//
// SECURITY (audit E-1): this process holds ONLY a price-relayer signing key and
// the PriceRelayerCap it owns. set_sui_price is gated on &PriceRelayerCap (NOT the
// AdminCap), so a full compromise of this hot server can push a price clamped to
// [MIN,MAX]_PRICE_SCALED and NOTHING else - it cannot drain a reserve, mint the
// 200M LP, pause a curve, or claim fees (all AdminCap, held cold in the multisig).
// An AdminCap id must NEVER appear in this process's env or code again.
//
// IMPORTANT: the client is passed in from index.js (its SuiGraphQLClient).
// Do NOT create a client here. JSON-RPC is forbidden (SuiClient/getFullnodeUrl).

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { V13_PACKAGE, PRICE_CONFIG_ID as CONFIGURED_PRICE_CONFIG_ID } from './write_target.js';

// ---- Config -----------------------------------------------------------------

// PACKAGE and PRICE_CONFIG_ID come from indexer/write_target.js (the single
// env-driven write-target module): SUIPUMP_V13_PACKAGE and SUIPUMP_PRICE_CONFIG.
// PRICE_RELAYER_CAP_ID is the PriceRelayerCap this process owns (audit E-1); it is
// the ONLY capability set_sui_price accepts. All three are env-only (never
// hardcoded); until all are set the publisher stays dormant rather than no-op.
// An AdminCap id must NEVER be read here - E-1 exists to keep the admin key off
// this hot server.
const PACKAGE             = V13_PACKAGE ?? '';
const PRICE_CONFIG_ID     = CONFIGURED_PRICE_CONFIG_ID ?? '';
const PRICE_RELAYER_CAP_ID = (process.env.SUIPUMP_PRICE_RELAYER_CAP ?? '').trim();

const SUI_CLOCK_ID = '0x6';

const PUSH_INTERVAL_MS = 5 * 60 * 1000;  // 5 min
const FETCH_TIMEOUT_MS = 5_000;

// Mirror of the contract bounds. Checked here too so a bad number never even
// reaches the chain and burns gas on an abort.
const MIN_PRICE_SCALED = 100;      // $0.10
const MAX_PRICE_SCALED = 100_000;  // $100.00

// Minimum sources that must agree before we publish. 2 of 3.
const MIN_SOURCES = 2;
// Max spread between the surviving sources. Above this they disagree enough that
// one is probably broken, and we would rather go stale than pick wrong.
const MAX_SPREAD = 0.05;  // 5%

// ---- Sources ----------------------------------------------------------------
//
// Chosen for INDEPENDENCE, not popularity. Three separate order books, three
// separate outages. Deliberately NOT CoinGecko/CoinMarketCap: they aggregate
// Binance and Coinbase among ~111 venues, so their number is CORRELATED with the
// other two. A median over correlated sources does not protect against the thing
// a median is for.
//
// Binance quotes SUI/USDT; Coinbase and Kraken quote SUI/USD. USDT normally
// tracks USD within ~0.1%, and the 5% spread guard catches a real depeg.

const SOURCES = [
  {
    name: 'binance',
    url:  'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT',
    parse: (j) => parseFloat(j?.price),
  },
  {
    name: 'coinbase',
    url:  'https://api.coinbase.com/v2/prices/SUI-USD/spot',
    parse: (j) => parseFloat(j?.data?.amount),
  },
  {
    name: 'kraken',
    url:  'https://api.kraken.com/0/public/Ticker?pair=SUIUSD',
    // Kraken keys the result by its own pair name, which is not always the one
    // you asked for. Take the first result entry and read c[0] (last trade).
    parse: (j) => {
      const r = j?.result;
      if (!r) return NaN;
      const k = Object.keys(r)[0];
      return parseFloat(r[k]?.c?.[0]);
    },
  },
];

async function fetchOne(src) {
  try {
    const res = await fetch(src.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'accept': 'application/json' },
    });
    if (!res.ok) {
      console.warn(`  [price] ${src.name} HTTP ${res.status}`);
      return null;
    }
    const price = src.parse(await res.json());
    if (!Number.isFinite(price) || price <= 0) {
      console.warn(`  [price] ${src.name} unparseable`);
      return null;
    }
    return { name: src.name, price };
  } catch (err) {
    console.warn(`  [price] ${src.name} failed: ${err.message}`);
    return null;
  }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Fetch all sources in parallel and reduce to one price we are willing to sign.
 * Returns null when we are not confident - the caller then does NOT push, and
 * the on-chain price ages out to the static fallback.
 */
export async function resolvePrice() {
  const results = (await Promise.all(SOURCES.map(fetchOne))).filter(Boolean);

  if (results.length < MIN_SOURCES) {
    console.warn(`  [price] only ${results.length}/${SOURCES.length} sources - NOT pushing`);
    return null;
  }

  const prices = results.map(r => r.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const spread = (hi - lo) / lo;

  if (spread > MAX_SPREAD) {
    console.error(
      `  [price] spread ${(spread * 100).toFixed(2)}% exceeds ${MAX_SPREAD * 100}% - NOT pushing. ` +
      results.map(r => `${r.name}=${r.price}`).join(' ')
    );
    return null;
  }

  const usd = median(prices);
  const scaled = Math.floor(usd * 1000);

  if (scaled < MIN_PRICE_SCALED || scaled > MAX_PRICE_SCALED) {
    console.error(`  [price] ${usd} -> ${scaled} outside contract bounds [${MIN_PRICE_SCALED},${MAX_PRICE_SCALED}] - NOT pushing`);
    return null;
  }

  console.log(
    `  [price] $${usd.toFixed(4)} -> ${scaled} ` +
    `(${results.map(r => `${r.name} ${r.price}`).join(', ')}; spread ${(spread * 100).toFixed(2)}%)`
  );
  return scaled;
}

// ---- Keypair (same pattern as auto_graduate.js) ------------------------------

function loadKeypair() {
  if (process.env.SUI_PRIVATE_KEY) {
    const raw  = fromBase64(process.env.SUI_PRIVATE_KEY);
    const seed = (raw.length === 33 || raw.length === 65) ? raw.slice(1) : raw;
    return Ed25519Keypair.fromSecretKey(seed);
  }
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  const raw  = fromBase64(keys[0]);
  return Ed25519Keypair.fromSecretKey(raw[0] === 0x00 ? raw.slice(1) : raw);
}

// ---- Push -------------------------------------------------------------------

async function pushPrice(client, keypair, priceScaled) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}::bonding_curve::set_sui_price`,
    arguments: [
      // audit E-1: set_sui_price(_cap: &PriceRelayerCap, cfg, price_scaled, clock).
      tx.object(PRICE_RELAYER_CAP_ID),
      tx.object(PRICE_CONFIG_ID),
      tx.pure.u64(priceScaled),
      tx.object(SUI_CLOCK_ID),
    ],
  });
  tx.setSender(keypair.toSuiAddress());

  // Build/sign/execute shape matches the repo's proven SuiGraphQLClient call
  // sites: suipump-nexus-tools/turnkey_signer.js signAndExecute (execute step:
  // executeTransaction({ transaction: <built bytes>, signatures: [<sig>] }) -
  // signatures is PLURAL, an array) and the frontend AgentPage userBuy flow.
  // `client` is index.js's SuiGraphQLClient. NEVER signAndExecuteTransaction
  // here, and never a JSON-RPC SuiClient.
  const bytes     = await tx.build({ client });
  const signature = (await keypair.signTransaction(bytes)).signature;
  const res = await client.executeTransaction({ transaction: bytes, signatures: [signature] });
  // SuiGraphQLClient returns a discriminated union (same shape bridge.js
  // consumes): surface FailedTransaction as a throw instead of a fake digest.
  if (res?.$kind === 'FailedTransaction' || res?.FailedTransaction) {
    const errText = res?.FailedTransaction?.status?.error ?? 'FailedTransaction';
    throw new Error(`set_sui_price failed: ${typeof errText === 'string' ? errText : JSON.stringify(errText)}`);
  }
  return res?.Transaction?.digest ?? res?.digest ?? 'unknown';
}

// ---- Loop -------------------------------------------------------------------

// Read the PriceRelayerCap's on-chain owner (address) via GraphQL. Returns null on
// any transport failure so a network blip never blocks startup - on-chain
// execution gives the final answer either way.
async function priceRelayerCapOwner(client) {
  try {
    const obj = await client.getObject({ objectId: PRICE_RELAYER_CAP_ID });
    return obj?.object?.owner?.AddressOwner ?? null;
  } catch {
    return null;
  }
}

export async function startPricePublisher(client) {
  // Dormancy gate (never crash the worker): require the full V13 price surface AND
  // a signer key. Missing any -> log dormant and continue; graduation runs
  // undampened at the static 9,000 SUI fallback until all are set.
  const missing = [];
  if (!PACKAGE)              missing.push('SUIPUMP_V13_PACKAGE');
  if (!PRICE_CONFIG_ID)      missing.push('SUIPUMP_PRICE_CONFIG');
  if (!PRICE_RELAYER_CAP_ID) missing.push('SUIPUMP_PRICE_RELAYER_CAP');
  if (!process.env.SUI_PRIVATE_KEY) missing.push('SUI_PRIVATE_KEY');
  if (missing.length) {
    console.warn(`  [price] price publisher dormant: missing ${missing.join(', ')}. Graduation runs undampened at the static 9,000 SUI fallback until set.`);
    return;
  }

  let keypair;
  try {
    keypair = loadKeypair();
  } catch (err) {
    console.warn(`  [price] price publisher dormant - no usable signer key: ${err.message}`);
    return;
  }
  const signer = keypair.toSuiAddress();

  // E-1 ownership guard: set_sui_price is an OWNED-object call, so the tx must be
  // signed by the wallet that OWNS the PriceRelayerCap or it aborts on ownership.
  // Assert it once at startup and fail LOUD (naming both) rather than push-loop
  // failing every 5 min. A transport failure only warns (on-chain has final say).
  const capOwner = await priceRelayerCapOwner(client);
  if (capOwner && capOwner.toLowerCase() !== signer.toLowerCase()) {
    console.error(
      `  [price] price publisher dormant - signer wallet ${signer} does NOT own the ` +
      `PriceRelayerCap ${PRICE_RELAYER_CAP_ID} (on-chain owner ${capOwner}). ` +
      `Set SUI_PRIVATE_KEY to the relayer wallet's key.`
    );
    return;
  }
  if (!capOwner) {
    console.warn(`  [price] could not verify PriceRelayerCap owner (transport) - proceeding; a wrong signer will be rejected on-chain.`);
  }

  // Unambiguous arming line (full ids, never truncated). Cadence in seconds so it
  // matches the "cadence Xs" contract in the ops runbook.
  console.log(`  [price] price publisher ARMED (relayer ${signer}, cap ${PRICE_RELAYER_CAP_ID}, cadence ${PUSH_INTERVAL_MS / 1000}s)`);
  console.log(`  [price] pkg ${PACKAGE}`);
  console.log(`  [price] cfg ${PRICE_CONFIG_ID}`);

  while (true) {
    try {
      const scaled = await resolvePrice();
      if (scaled !== null) {
        const digest = await pushPrice(client, keypair, scaled);
        console.log(`  [price] published ${scaled} - ${digest}`);
      }
      // scaled === null: deliberate no-push. The on-chain value ages toward the
      // 30-min staleness window and buy() falls back to BASE_GRAD_MIST. Safe.
    } catch (err) {
      // A failed push is NOT fatal. Log and try again next tick.
      console.error(`  [price] push failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, PUSH_INTERVAL_MS));
  }
}
