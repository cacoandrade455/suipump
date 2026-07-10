// Flame.jsx - SuiPump brand mark (SVG flame system, "Terminal" redesign 2a).
//
// One geometry, four cuts (per the brand screen in SuiPump_Redesign.dc.html):
//   aurora - vertical gradient #d9f99d -> #a3e635 (45%) -> #4d7c0f, ember #d9f99d.
//            Landing, OG images, whitepaper cover.
//   solid  - flat #84cc16, ember #a3e635. Product UI, headers, favicon.
//   strike - solid + diagonal slash through the body. Win states, graduation.
//   pulse  - outline only (outer tongue), stroke #a3e635. Loading, empty states.
//
// The paths below are the CANONICAL logo geometry. Never redraw or "clean up"
// these curves - every rendering of the mark anywhere in the app must come
// from this component (or from assets rasterized from these exact paths).
//
// viewBox is 96x96; size prop sets both width and height (the mark is square).
// Each instance gets a unique gradient id via useId so multiple aurora flames
// on one page never collide.
import React, { useId } from 'react';

// Full body: two tongues + live core (evenodd knocks the core out of the body).
export const FLAME_BODY_PATH =
  'M60 4C64 16 72 30 72 50A22 22 0 0 1 28 50C28 44 30 39 33 41C29 33 29 24 33 15C36 26 40 29 42 27C45 20 55 14 60 4ZM50 42C54 51 58 55 58 63A9.5 9.5 0 0 1 39 63C39 55 45 51 47 44C48 42 49 41 50 42Z';

// Outer tongue only - used by the PULSE (outline) cut.
export const FLAME_OUTLINE_PATH =
  'M60 4C64 16 72 30 72 50A22 22 0 0 1 28 50C28 44 30 39 33 41C29 33 29 24 33 15C36 26 40 29 42 27C45 20 55 14 60 4Z';

// STRIKE cut: body + diagonal slash (single evenodd path so the slash reads
// as part of the mark, exactly as drawn in the design file).
export const FLAME_STRIKE_PATH =
  FLAME_BODY_PATH + 'M26 50L74 32L74 39L26 57Z';

// Brand color constants (mirror tailwind.config.js theme.extend.colors.sp).
export const SP_PUMP    = '#84cc16'; // primary lime - progress, wins, CTAs
export const SP_GLOW    = '#a3e635'; // bright lime - embers, pulses, accents
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
        <circle cx="71" cy="9" r="4" fill="none" stroke={SP_GLOW} strokeWidth="3" />
      </svg>
    );
  }

  const isAurora = variant === 'aurora';
  const bodyPath = variant === 'strike' ? FLAME_STRIKE_PATH : FLAME_BODY_PATH;
  const bodyFill = isAurora ? `url(#${gradId})` : SP_PUMP;
  const emberFill = isAurora ? SP_AURORA[0] : SP_GLOW;

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
      <circle cx="71" cy="9" r="4.5" fill={emberFill} />
    </svg>
  );
}

/**
 * <FlameLockup size markSize variant glow /> - flame + "suipump_" wordmark.
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
