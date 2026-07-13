// Flame.jsx - SuiPump brand mark (SVG torch system, brand v2, 2026-07-13).
//
// The TORCH supersedes the two-tongue flame of redesign 2a. Both design HTMLs
// (SuiPump_Redesign.dc.html / SuiPump_Mobile_dc.html) still draw the OLD mark;
// never restore it from there - the B-LOGO entry in RECONCILIATION_LEDGER.md
// is the ruling. Source cuts live in frontend-app/public/ (torch-solid.svg,
// torch-outline.svg, torch-aurora-1024.png, app-icon-*.png).
//
// One geometry, four cuts:
//   aurora - vertical gradient #d9f99d -> #a3e635 (45%) -> #4d7c0f.
//            Landing hero, OG images, whitepaper cover.
//   solid  - flat #84cc16. Product UI, headers, favicon.
//   strike - solid + diagonal slash through the body. Win states, graduation.
//   pulse  - outline only (outer tongue), stroke #a3e635 width 5. Loading,
//            empty states, stickers.
//
// BRAND RULES v2: always green - hollow core, NEVER an ember - lowercase
// wordmark suipump_. The v1 ember circle is gone from every cut, including
// the pulse cut's stroked ember.
//
// The paths below are the CANONICAL logo geometry. Never redraw or "clean up"
// these curves - every rendering of the mark anywhere in the app must come
// from this component (or from assets rasterized from these exact paths).
//
// viewBox is 96x96; size prop sets both width and height (the mark is square).
// Each instance gets a unique gradient id via useId so multiple aurora torches
// on one page never collide.
import React, { useId } from 'react';

// Full body: outer tongue + drop core (evenodd knocks the core out of the body).
export const FLAME_BODY_PATH =
  'M48 6 C42 28 22 34 22 58 A26 26 0 0 0 74 58 C74 40 62 32 58 20 C56 30 52 30 48 6 Z M48 50 C46 60 38 62 38 70 A10 10 0 0 0 58 70 C58 61 50 60 48 50 Z';

// Outer tongue only - used by the PULSE (outline) cut and tiny favicons.
export const FLAME_OUTLINE_PATH =
  'M48 6 C42 28 22 34 22 58 A26 26 0 0 0 74 58 C74 40 62 32 58 20 C56 30 52 30 48 6 Z';

// STRIKE cut: body + diagonal slash (single evenodd path so the slash reads
// as a knockout stripe through the mark). Slash coords carried over from
// brand v1 so 'strike' call sites keep working; pixel-check on preview where
// the slash crosses the drop core, retire the cut if it is unused.
export const FLAME_STRIKE_PATH =
  FLAME_BODY_PATH + 'M26 50L74 32L74 39L26 57Z';

// Brand color constants (mirror tailwind.config.js theme.extend.colors.sp).
export const SP_PUMP    = '#84cc16'; // primary lime - progress, wins, CTAs
export const SP_GLOW    = '#a3e635'; // bright lime - pulses, accents
export const SP_VOID    = '#050505'; // background black
export const SP_AURORA  = ['#d9f99d', '#a3e635', '#4d7c0f']; // gradient stops (0 / .45 / 1)

/**
 * <Flame variant size glow className style />
 *
 * variant: 'solid' (default) | 'aurora' | 'strike' | 'pulse'
 * size:    number (px) - width and height. Default 24.
 * glow:    boolean - lime drop-shadow (the design uses it on hero/lockup marks).
 */
export default function Flame({ variant = 'solid', size = 24, glow = false, className = '', style = {} }) {
  const uid = useId();
  const gradId = `sp-flame-aurora-${uid}`;

  const glowFilter = glow
    ? { filter: variant === 'aurora'
        ? 'drop-shadow(0 14px 40px rgba(132,204,22,.5))'
        : 'drop-shadow(0 0 10px rgba(163,230,53,.9))' }
    : {};

  if (variant === 'pulse') {
    return (
      <svg width={size} height={size} viewBox="0 0 96 96" className={className}
        style={{ flex: 'none', ...glowFilter, ...style }} aria-hidden="true">
        <path d={FLAME_OUTLINE_PATH} fill="none" stroke={SP_GLOW} strokeWidth="5" strokeLinejoin="round" />
      </svg>
    );
  }

  const isAurora = variant === 'aurora';
  const bodyPath = variant === 'strike' ? FLAME_STRIKE_PATH : FLAME_BODY_PATH;
  const bodyFill = isAurora ? `url(#${gradId})` : SP_PUMP;

  return (
    <svg width={size} height={size} viewBox="0 0 96 96" className={className}
      style={{ flex: 'none', ...glowFilter, ...style }} aria-hidden="true">
      {isAurora && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={SP_AURORA[0]} />
            <stop offset=".45" stopColor={SP_AURORA[1]} />
            <stop offset="1" stopColor={SP_AURORA[2]} />
          </linearGradient>
        </defs>
      )}
      <path fillRule="evenodd" clipRule="evenodd" d={bodyPath} fill={bodyFill} />
    </svg>
  );
}

/**
 * <FlameLockup size markSize variant glow /> - torch + "suipump_" wordmark.
 * The trailing underscore blinks lime (sp-blink keyframes live in index.css).
 * size: wordmark font size in px (default 17, the header lockup).
 */
export function FlameLockup({ size = 17, markSize = 24, variant = 'solid', glow = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-[9px] ${className}`}>
      <Flame variant={variant} size={markSize} glow={glow} />
      <span
        className="font-extrabold text-white"
        style={{ fontSize: size, lineHeight: 1, letterSpacing: '-.02em', fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
        suipump<span className="text-sp-glow sp-blink">_</span>
      </span>
    </span>
  );
}
