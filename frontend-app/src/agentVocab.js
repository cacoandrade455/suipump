// agentVocab.js — SHARED intent vocabulary for the SuiPump agent.
//
// One source of truth for "what a user can say" — consumed by BOTH:
//   1. the deterministic client parsers in AgentPage.jsx (fast path), and
//   2. the LLM planner in api/agent-plan.js (fallback), which embeds the
//      synonym lists and examples below into its system prompt.
//
// Keeping these in one module means a phrasing added here is understood by both
// paths at once — the parser and the LLM never drift apart on vocabulary. Pure
// data + tiny pure helpers; no React, no I/O, safe to import anywhere.

// ── Number-word + unit normalization ─────────────────────────────────────────
// Turns spoken amounts into digits BEFORE the regexes run, so "half a sui",
// "a couple sui", "point five", "1.5k" all parse. Applied to the lowercased goal.
const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, hundred: 100,
  a: 1, an: 1, // "a sui", "an entry" -> 1 (only when followed by a unit; see below)
};

// Fractions and loose quantifiers -> numeric.
const FRACTION_PHRASES = [
  [/\bhalf\s+(?:a\s+|an\s+)?/g, '0.5 '],
  [/\bquarter\s+(?:a\s+|of\s+a\s+)?/g, '0.25 '],
  [/\bthree[\s-]quarters?\s+(?:of\s+a\s+)?/g, '0.75 '],
  [/\ba\s+couple\s+(?:of\s+)?/g, '2 '],
  [/\ba\s+few\s+/g, '3 '],
  [/\bpoint\s+(\d)/g, '0.$1'],          // "point 5" -> "0.5"
  // "point five/four/..." (word form) -> "0.5": handled before the digit pass.
  [/\bpoint\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_, w) => `0.${({ zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9 })[w]}`],
];

// Normalize a raw goal string for parsing: lowercase, expand k/m suffixes,
// fractions, and number-words adjacent to a unit. Returns a new string; never
// mutates intent, only rewrites quantities into digits the regexes already expect.
export function normalizeGoalText(raw) {
  let s = String(raw || '').toLowerCase();
  // Leading-dot decimals: ".5 sui" -> "0.5 sui" so the numeric regexes match.
  s = s.replace(/(^|[^\d.])\.(\d)/g, '$10.$2');

  // "1.5k sui" -> "1500 sui"; "2m" -> "2000000". Only when followed by a
  // space/sui/token so we don't mangle hex or addresses.
  s = s.replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Number(n) * 1_000));
  s = s.replace(/(\d+(?:\.\d+)?)\s*m\b(?!\w)/g, (_, n) => String(Number(n) * 1_000_000));

  for (const [re, rep] of FRACTION_PHRASES) s = s.replace(re, rep);

  // "point five" leftover -> "0.5": handle the word after "0." produced above.
  s = s.replace(/0\.(zero|one|two|three|four|five|six|seven|eight|nine)/g,
    (_, w) => `0.${WORD_NUMBERS[w]}`);

  // Number-word directly before a unit/keyword -> digit. Guard "a/an" so it only
  // converts when it quantifies a unit (e.g. "a sui", "an entry"), never plain "a".
  s = s.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|an?)\s+(sui|token|tokens|entry|entries|position|positions|trade|trades|buy|buys)\b/g,
    (m, w, unit) => `${WORD_NUMBERS[w] ?? m.split(' ')[0]} ${unit}`,
  );

  return s;
}

// ── Amount extraction (SUI) ──────────────────────────────────────────────────
// Pull a SUI amount near a set of keywords. Reused by every parser so "5 sui",
// "5 sui per trade", "with 5 sui", "0.5 a pop" all resolve consistently.
const SUI_NUM = '(\\d+(?:\\.\\d+)?)';

// Per-entry / per-trade size: how much SUI each individual action spends.
export function extractPerEntrySui(lower, fallback = 0.5) {
  const pats = [
    new RegExp(`${SUI_NUM}\\s*sui\\s*(?:per|each|/|a)\\s*(?:trade|entry|buy|position|pop)`),
    new RegExp(`(?:per|each)\\s*(?:trade|entry|buy|position)?\\s*${SUI_NUM}\\s*sui`),
    new RegExp(`${SUI_NUM}\\s*sui\\s*(?:a\\s*)?(?:pop|shot|clip)`),
    new RegExp(`(?:small|tiny)\\s*${SUI_NUM}\\s*sui`),
  ];
  for (const re of pats) { const m = lower.match(re); if (m) return Number(m[1]); }
  return fallback;
}

// Total spend cap / budget / bankroll: the ceiling across all actions.
export function extractSpendCapSui(lower, fallback = null) {
  const pats = [
    new RegExp(`(?:max|budget|cap|total|bankroll|up\\s*to|deploy|spend|risk)\\s*(?:of\\s*)?${SUI_NUM}\\s*sui`),
    new RegExp(`${SUI_NUM}\\s*sui\\s*(?:budget|cap|total|max|bankroll|to\\s*(?:deploy|spend|trade|play\\s*with|risk))`),
    new RegExp(`(?:with|up\\s*to)\\s*(?:a\\s*)?${SUI_NUM}\\s*sui`),
    new RegExp(`${SUI_NUM}\\s*sui\\b`), // last-resort: any bare "N sui"
  ];
  for (const re of pats) { const m = lower.match(re); if (m) return Number(m[1]); }
  return fallback;
}

// ── Time-interval extraction (DCA TIME mode) ─────────────────────────────────
// "every 30 min", "hourly", "twice a day", "each morning" -> milliseconds.
const INTERVAL_WORDS = {
  hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000,
};
export function extractIntervalMs(lower, fallback = null) {
  if (/\btwice\s+(?:a\s+)?day|2x\s*(?:a\s*)?day\b/.test(lower)) return 43_200_000;
  for (const [w, ms] of Object.entries(INTERVAL_WORDS)) if (new RegExp(`\\b${w}\\b`).test(lower)) return ms;
  const m = lower.match(/every\s+(\d+)?\s*(second|sec|minute|min|hour|hr|day|week)s?/);
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    const unit = { second: 1e3, sec: 1e3, minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5 }[m[2]];
    return n * unit;
  }
  return fallback;
}

// ── Intent trigger vocabularies ──────────────────────────────────────────────
// Each workflow's recognizable verbs/phrases. The parsers test these; the LLM
// prompt lists them so the model classifies the same way. Centralizing here is
// what keeps the two paths in lockstep.
export const INTENT = {
  autopilot: {
    // Hands-off autonomous trading with NO named curve. The agent discovers.
    triggers: [
      /\bautopilot\b/, /\bauto[-\s]?trade\b/, /\btrade for me\b/,
      /\b(?:ape|buy|trade|farm|degen|send\s+it)\b[\s\S]*\b(?:trending|pumping|hot|the\s+market|best\s+(?:tokens|coins)|memecoins?|for\s+me|whatever)\b/,
      /\b(?:run|put|set|let)\b[\s\S]*\b(?:agent|bot|it)\b[\s\S]*\b(?:loose|to\s+work|autopilot|trade|wild)\b/,
      /\b(?:find|pick|scan)\b[\s\S]*\b(?:good|best|trending|hot)\b[\s\S]*\b(?:tokens?|coins?)\b[\s\S]*\b(?:buy|enter|ape|trade)\b/,
      /\btrade\b[\s\S]*\b(?:automatically|on\s+its?\s+own|24\/?7|hands[\s-]?off)\b/,
      /\bdeploy\b[\s\S]*\bsui\b[\s\S]*\b(?:across|into)\b[\s\S]*\b(?:trending|tokens|coins|memes?)\b/,
    ],
    examples: [
      'autopilot 0.5 sui per entry, 3 sui total, take profit at 50%, stop loss at 30%',
      'ape into trending memecoins for me, half a sui each, 5 sui bankroll',
      'trade the market automatically, 1 sui per position, max 4 positions, sell at 2x',
      'let the bot loose on trending coins with 10 sui, point five each',
    ],
  },
  sniper: {
    triggers: [
      /\bsnipe\b|\bsniper\b/,
      /\b(?:buy|ape|grab|get)\b[\s\S]*\b(?:every|all)\b[\s\S]*\b(?:token|launch|coin)/,
      /\b(?:every|all)\b[\s\S]*\b(?:token|launch|coin)s?\b[\s\S]*\b(?:launched\s+)?by\b/,
    ],
    examples: [
      'snipe 1 sui of every new launch',
      'buy 2 sui of every token launched by 0xCREATOR, take profit at 50%',
    ],
  },
  dca: {
    triggers: [
      /\bdca\b|\bdollar[\s-]?cost\b|\baverage\s+(?:in|down)\b|\bscale\s+in\b|\baccumulate\b/,
      /\bevery\s+(?:\d+\s*)?(?:second|sec|minute|min|hour|hr|day|week)s?\b/,
      /\bhourly\b|\bdaily\b|\bweekly\b|\btwice\s+(?:a\s+)?day\b/,
    ],
    examples: [
      'buy 5 sui of 0xCURVE every day for 10',
      'dca 2 sui into 0xCURVE hourly, take profit at 20%',
      'buy 5 sui of 0xCURVE, buy 5 more if it drops 10%',
    ],
  },
  copytrade: {
    triggers: [/\b(copy|mirror|shadow|follow|copytrade|copy[\s-]?trade)\b/],
    examples: ['copy wallet 0xWALLET buying 5 sui per trade', 'mirror 0xWALLET at 2 sui each'],
  },
};

// True if the goal is an autopilot intent AND does NOT name a specific curve.
// Autopilot is curve-less by definition; a 0x curve id means it's a targeted
// buy/strategy, not autopilot. This guard is the fix for the autopilot<->buy
// ambiguity: "buy the trending token 0xABC" has a CA -> NOT autopilot.
export function isAutopilotIntent(lower) {
  const hasCurve = /0x[0-9a-fA-F]{60,66}/.test(lower);
  if (hasCurve) return false;
  return INTENT.autopilot.triggers.some((re) => re.test(lower));
}

// isTrendingDiscovery — true when the goal is about discovering tokens that are
// ALREADY trending/pumping/hot (autopilot's domain), as opposed to sniping NEW
// launches (sniper's domain). The disambiguator between "ape into every token
// that's trending" (autopilot) and "snipe every new launch" (sniper): a
// discovery word is present AND there is NO launch-time word. Sniper uses this
// to YIELD so a trending goal routes to autopilot even though both match
// "every ... token".
export function isTrendingDiscovery(lower) {
  const discovery = /\b(trending|pumping|hot\b|the\s+market|best\s+(?:tokens?|coins?)|memecoins?|whatever(?:'?s)?\s+(?:pumping|hot|trending))\b/.test(lower);
  if (!discovery) return false;
  // A launch-time goal is sniper territory even if it says "hot" — require the
  // ABSENCE of launch words for this to count as trending-discovery.
  const launchWord = /\b(launch(?:ed|es|ing)?|new\s+(?:token|coin|launch)|on\s+launch|at\s+launch|the\s+(?:second|moment|instant)\s+(?:it|a)\s+launch)/.test(lower);
  return !launchWord;
}

// Build the vocabulary block the LLM planner embeds in its prompt, so the model
// classifies with the SAME triggers/examples the parsers use. Returns a string.
export function llmVocabBlock() {
  const lines = [];
  for (const [wf, def] of Object.entries(INTENT)) {
    lines.push(`${wf.toUpperCase()} — recognize phrasings like:`);
    for (const ex of def.examples) lines.push(`  • "${ex}"`);
  }
  return lines.join('\n');
}
