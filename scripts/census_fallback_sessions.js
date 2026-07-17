// census_fallback_sessions.js - READ-ONLY one-off census (Task B0, F-6 acceptance basis)
//
// Counts agent sessions that were ever signed by the shared agent wallet
// 0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906
// (the silent Turnkey fallback), and how many are still LIVE.
//
// Signal (chain-verified): agent_session enforces tx sender == session_address,
// and every provisioned Turnkey/enclave key gets its own unique Sui address.
// Therefore a session was fallback-signed IFF its SessionOpened event carries
// session_address == the shared agent wallet. No bridge DB access is needed;
// the indexer events table plus live on-chain state is conclusive.
//
// LIVE = the session object still exists on-chain AND revoked == false AND
// expiry_ms != 0 (the V11+ CLOSED sentinel) AND expiry_ms > now.
//
// This script performs ZERO writes: SELECTs on the indexer Postgres and
// GraphQL object reads only.
//
// Run (Windows cmd, from the repo root):
//   cd scripts
//   npm install pg          (one-time; pg is not in scripts/package.json)
//   set DATABASE_URL=<indexer Render Postgres external connection string>
//   node census_fallback_sessions.js
//
// Optional: set SUI_GRAPHQL_URL to override https://graphql.testnet.sui.io/graphql

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import pg from 'pg';

const SHARED_AGENT_WALLET =
  '0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906';

const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';

const MIST_PER_SUI = 1_000_000_000n;

function fmtSui(mist) {
  const m = BigInt(mist);
  return `${Number(m) / Number(MIST_PER_SUI)} SUI (${m} MIST)`;
}

// Balance<SUI> renders differently across GraphQL json shapes; accept both the
// bare string/number and the { value: ... } wrapping.
function balanceValue(v) {
  if (v == null) return 0n;
  if (typeof v === 'object') return balanceValue(v.value);
  return BigInt(v);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set - point it at the indexer Postgres. Aborting (read-only script, nothing was touched).');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 2,
  });

  // All sessions ever opened with the shared wallet as session_address.
  // event_type is the full `${pkg}::agent_session::SessionOpened` string, so
  // match on the suffix exactly like agent_session_api.js does.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (data->>'session_id')
            data->>'session_id'      AS session_id,
            data->>'owner'           AS owner,
            data->>'deposit'         AS deposit,
            data->>'expiry_ms'       AS opened_expiry_ms,
            timestamp_ms             AS opened_at_ms,
            tx_digest
       FROM events
      WHERE event_type LIKE '%SessionOpened'
        AND LOWER(data->>'session_address') = LOWER($1)
      ORDER BY data->>'session_id', timestamp_ms DESC NULLS LAST`,
    [SHARED_AGENT_WALLET]
  );
  await pool.end();

  console.log(`Fallback-session census - shared agent wallet ${SHARED_AGENT_WALLET}`);
  console.log(`GraphQL endpoint: ${GRAPHQL_URL}`);
  console.log('');
  console.log(`TOTAL fallback sessions ever opened: ${rows.length}`);

  const client = new SuiGraphQLClient({ url: GRAPHQL_URL });
  const now = Date.now();
  const live = [];
  let liveEscrowMist = 0n;

  for (const row of rows) {
    const sessionId = row.session_id;
    let state = 'UNKNOWN';
    let escrowMist = 0n;
    try {
      const obj = await client.getObject({ objectId: sessionId, include: { json: true } });
      const json = obj?.object?.json;
      if (!json) {
        state = 'GONE (object no longer readable on-chain)';
      } else {
        const expiryMs = Number(json.expiry_ms ?? 0);
        const revoked = json.revoked === true || json.revoked === 'true';
        escrowMist = balanceValue(json.escrow);
        if (revoked || expiryMs === 0) state = 'CLOSED (revoked / expiry_ms==0 sentinel)';
        else if (expiryMs <= now) state = `EXPIRED (expiry_ms ${expiryMs} <= now ${now})`;
        else state = 'LIVE';
      }
    } catch (e) {
      state = `READ ERROR (${e?.message ?? e})`;
    }
    const isLive = state === 'LIVE';
    if (isLive) {
      live.push({ sessionId, escrowMist, owner: row.owner });
      liveEscrowMist += escrowMist;
    }
    console.log(`  ${sessionId}  opened_at_ms=${row.opened_at_ms ?? '-'}  owner=${row.owner ?? '-'}  state=${state}${escrowMist > 0n ? `  escrow=${fmtSui(escrowMist)}` : ''}`);
  }

  console.log('');
  console.log(`LIVE fallback sessions: ${live.length}`);
  for (const s of live) {
    console.log(`  LIVE ${s.sessionId}  owner=${s.owner ?? '-'}  escrow=${fmtSui(s.escrowMist)}`);
  }
  console.log(`TOTAL escrow SUI parked in LIVE fallback sessions: ${fmtSui(liveEscrowMist)}`);
  console.log('');
  console.log('Paste this output into contracts-v10/AUDIT_NOTES.md (F-6 census TODO).');
}

main().catch((e) => {
  console.error('census failed:', e);
  process.exit(1);
});
