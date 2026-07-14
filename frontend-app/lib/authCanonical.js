// lib/authCanonical.js - the ONE canonicalization both auth halves share.
// Imported by lib/verifyOwner.js (server, Vercel functions) AND by
// src/authSign.js (client). Pure functions, zero dependencies, no secrets -
// safe to bundle client-side. Lives outside api/ so it never deploys as a
// public route.
//
// Canonical message format (version-prefixed so it can evolve):
//   suipump-auth-v1|<route>|<ts>|<stableStringify(fields)>
// where `fields` is the request body WITHOUT the signature/ts pair. The
// client signs this string as a personal message; the server rebuilds the
// SAME string from the body fields it already validates and verifies the
// signature against that - a client-supplied message is never trusted.

// Recursively rebuild objects with sorted keys so serialization is
// independent of insertion order (client build order vs server JSON.parse
// order). Arrays keep their order - order is meaningful there.
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

// Deterministic stringify with exact JSON wire semantics. The JSON round
// trip first normalizes the value the way it travels on the wire (drops
// undefined-valued keys, collapses -0 to 0), so the client signing a live JS
// object and the server hashing a parsed body always see identical bytes.
export function stableStringify(value) {
  const normalized = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(sortKeysDeep(normalized));
}

export function canonicalAuthMessage(route, ts, fields) {
  return `suipump-auth-v1|${route}|${Number(ts)}|${stableStringify(fields)}`;
}
