// api/rpc.js — Vercel edge function: proxies GraphQL requests to Sui testnet
// Strategies in the browser hit this endpoint instead of graphql.testnet.sui.io
// which blocks cross-origin requests from suipump.org.

export const config = { runtime: 'edge' };

const UPSTREAM = 'https://graphql.testnet.sui.io/graphql';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.text();

    const upstream = await fetch(UPSTREAM, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ errors: [{ message: err.message }] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}
