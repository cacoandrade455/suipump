// GamePage.jsx — "PUMP RUN" — a cartoon souls-like platformer for SuiPump.
//
// One arena. A swarm of horror capsule-minions, then a giant capsule BOSS.
// Player is the pump mascot (/mascot_pump.png). Every enemy is drawn
// PROCEDURALLY at runtime via Phaser Graphics -> generateTexture, so there are
// no external enemy assets and nothing resembling any real brand: just generic
// pharmaceutical capsules turned sinister (red eyes, cracked outline, oozing
// drip). Theme: black / lime / blood-red.
//
// Mechanics: run, jump, stamina-gated dodge-roll (i-frames), parry window,
// light attack. Souls-like loop: clear the swarm to wake the boss, learn the
// boss patterns, die a lot, respawn.
//
// SAVE MODEL: local-first, wallet-as-identity.
//   - localStorage saves silently when a phase clears.
//   - "SAVE TO WALLET" POSTs the same state to the indexer keyed by wallet
//     address, so progress follows across devices. Never signs a tx or moves
//     funds — wallet is identity only.
//
// Uses the public mascot PNG already shipped: /mascot_pump.png -> player.
// Route in App.jsx:
//   <Route path="/play" element={<GamePage onBack={() => navigate('/')} lang={lang} />} />

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Phaser from 'phaser';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ArrowLeft, Heart, Zap, Save, Trophy, RotateCcw, Skull } from 'lucide-react';

// ── Indexer endpoint (same base the rest of the app uses) ──────────────────────
const INDEXER_URL = 'https://suipump-62s2.onrender.com';
const LOCAL_KEY = 'suipump_pumprun_save_v2';

// ── Layout ──────────────────────────────────────────────────────────────────────
const GAME_W = 960;
const GAME_H = 540;
const GROUND_Y = GAME_H - 60;

// ── Player tunables ───────────────────────────────────────────────────────────
const PLAYER_SPEED = 240;
const JUMP_VELOCITY = -560;
const DOUBLE_JUMP_VELOCITY = -500;   // air jump, slightly weaker
const MAX_JUMPS = 2;                  // ground jump + 1 air jump
const GRAVITY_Y = 1500;

const PLAYER_MAX_HP = 100;
const MINION_TOUCH_DMG = 10;
const BOSS_TOUCH_DMG = 18;
const PROJECTILE_DMG = 16;
const ATTACK_DMG_MINION = 34;
const ATTACK_DMG_BOSS = 14;
const FIREBALL_SPEED = 560;
const FIREBALL_LIFETIME_MS = 1400;
const PARRY_REFLECT_DMG = 60;     // reflected boss shot hits hard
const PARRY_STAGGER_MS = 1400;    // boss frozen + open to damage

const STAMINA_MAX = 100;
const STAMINA_REGEN = 28;
const DODGE_COST = 35;
const DODGE_IFRAMES_MS = 360;
const DODGE_SPEED = 520;
const DODGE_DURATION_MS = 280;
const PARRY_WINDOW_MS = 180;
const PARRY_COST = 20;
const ATTACK_COOLDOWN_MS = 320;

const MINION_HP = 30;
const MINION_COUNT = 7;
const MINION_SPEED = 70;
const BOSS_MAX_HP = 460;

// ── localStorage helpers — never throw ──
function loadLocal() {
  try { const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); return (v && typeof v === 'object') ? v : null; }
  catch { return null; }
}
function saveLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Procedural capsule texture generator. Draws a tilted pill: one lime half,
// one pale half, dark outline, then horror layered on top — red glowing eyes,
// cracks across the shell, and an oozing drip. Returns a unique texture key.
// ─────────────────────────────────────────────────────────────────────────────
function makeCapsuleTexture(scene, key, opts = {}) {
  const w = opts.w || 64;
  const h = opts.h || 64;
  const boss = !!opts.boss;
  const g = scene.add.graphics();

  const cx = w / 2, cy = h / 2;
  const len = w * 0.72;
  const rad = h * 0.22;
  const angle = -0.6;

  const dx = Math.cos(angle) * (len / 2 - rad);
  const dy = Math.sin(angle) * (len / 2 - rad);
  const ax = cx - dx, ay = cy - dy;   // lime lobe center
  const bx = cx + dx, by = cy + dy;   // pale lobe center

  const px = Math.cos(angle + Math.PI / 2);
  const py = Math.sin(angle + Math.PI / 2);

  const OUTLINE = 0x12302a;

  // lime half
  g.fillStyle(0x3fae6e, 1);
  g.beginPath();
  g.arc(ax, ay, rad, angle + Math.PI / 2, angle - Math.PI / 2, false);
  g.lineTo(cx + px * rad, cy + py * rad);
  g.lineTo(cx - px * rad, cy - py * rad);
  g.closePath();
  g.fillPath();

  // pale half
  g.fillStyle(0xcfe0d8, 1);
  g.beginPath();
  g.arc(bx, by, rad, angle - Math.PI / 2, angle + Math.PI / 2, false);
  g.lineTo(cx - px * rad, cy - py * rad);
  g.lineTo(cx + px * rad, cy + py * rad);
  g.closePath();
  g.fillPath();

  // full outline
  g.lineStyle(boss ? 7 : 5, OUTLINE, 1);
  g.beginPath();
  g.arc(ax, ay, rad, angle + Math.PI / 2, angle + 3 * Math.PI / 2, false);
  g.arc(bx, by, rad, angle - Math.PI / 2, angle + Math.PI / 2, false);
  g.closePath();
  g.strokePath();
  g.lineStyle(boss ? 5 : 3, OUTLINE, 1);
  g.lineBetween(cx + px * rad, cy + py * rad, cx - px * rad, cy - py * rad);

  // ── HORROR LAYER ──
  const eyeR = boss ? rad * 0.20 : rad * 0.26;
  const eo = rad * 0.42;
  const ex1 = ax + px * eo - Math.cos(angle) * rad * 0.15;
  const ey1 = ay + py * eo - Math.sin(angle) * rad * 0.15;
  const ex2 = ax - px * eo - Math.cos(angle) * rad * 0.15;
  const ey2 = ay - py * eo - Math.sin(angle) * rad * 0.15;
  g.fillStyle(0xff2a2a, 0.35);
  g.fillCircle(ex1, ey1, eyeR * 1.9);
  g.fillCircle(ex2, ey2, eyeR * 1.9);
  g.fillStyle(0xff0000, 1);
  g.fillCircle(ex1, ey1, eyeR);
  g.fillCircle(ex2, ey2, eyeR);
  g.fillStyle(0x12302a, 1);
  g.fillCircle(ex1, ey1, eyeR * 0.4);
  g.fillCircle(ex2, ey2, eyeR * 0.4);

  // fanged mouth
  g.fillStyle(0x12302a, 1);
  const mouthCx = ax - Math.cos(angle) * rad * 0.55;
  const mouthCy = ay - Math.sin(angle) * rad * 0.55;
  const teeth = boss ? 6 : 4;
  const span = rad * 1.1;
  for (let i = 0; i < teeth; i++) {
    const tt = (i / (teeth - 1) - 0.5);
    const txp = mouthCx + px * tt * span;
    const typ = mouthCy + py * tt * span;
    g.beginPath();
    g.moveTo(txp - px * (span / teeth) * 0.4, typ - py * (span / teeth) * 0.4);
    g.lineTo(txp + px * (span / teeth) * 0.4, typ + py * (span / teeth) * 0.4);
    g.lineTo(txp - Math.cos(angle) * rad * 0.5, typ - Math.sin(angle) * rad * 0.5);
    g.closePath();
    g.fillPath();
  }

  // cracks
  g.lineStyle(boss ? 3 : 2, 0x0c211d, 0.9);
  g.lineBetween(bx, by, cx + px * rad * 0.3, cy + py * rad * 0.3);
  g.lineBetween(cx + px * rad * 0.3, cy + py * rad * 0.3, cx + px * rad * 0.9 - dx * 0.4, cy + py * rad * 0.9 - dy * 0.4);
  g.lineBetween(bx, by, bx + px * rad * 0.6, by + py * rad * 0.6);

  // ooze drip
  const dripX = ax - Math.cos(angle) * rad * 0.2 - px * rad * 0.2;
  const dripY = ay - Math.sin(angle) * rad * 0.2 - py * rad * 0.2 + rad * 0.6;
  g.fillStyle(0x2fae5e, 0.9);
  g.fillCircle(dripX, dripY + rad * 0.5, rad * 0.16);
  g.fillRect(dripX - rad * 0.06, dripY, rad * 0.12, rad * 0.55);

  g.generateTexture(key, w, h);
  g.destroy();
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Procedural fireball — a radial bloom: white-hot core, lime mid, orange edge,
// with a few jagged flame tongues. Looks like a charged Hadouken in the brand
// palette. Returns the texture key.
// ─────────────────────────────────────────────────────────────────────────────
function makeFireballTexture(scene, key, size = 48) {
  const g = scene.add.graphics();
  const cx = size / 2, cy = size / 2;
  const r = size * 0.42;

  // outer orange glow
  g.fillStyle(0xff7a18, 0.35); g.fillCircle(cx, cy, r * 1.15);
  // flame tongues (orange) radiating out
  g.fillStyle(0xff6a00, 0.9);
  const tongues = 8;
  for (let i = 0; i < tongues; i++) {
    const a = (i / tongues) * Math.PI * 2;
    const tx = cx + Math.cos(a) * r * 1.25;
    const ty = cy + Math.sin(a) * r * 1.25;
    const pax = cx + Math.cos(a + 0.25) * r * 0.7;
    const pay = cy + Math.sin(a + 0.25) * r * 0.7;
    const pbx = cx + Math.cos(a - 0.25) * r * 0.7;
    const pby = cy + Math.sin(a - 0.25) * r * 0.7;
    g.beginPath(); g.moveTo(pax, pay); g.lineTo(tx, ty); g.lineTo(pbx, pby); g.closePath(); g.fillPath();
  }
  // orange body
  g.fillStyle(0xff8c1a, 1); g.fillCircle(cx, cy, r);
  // lime mid ring
  g.fillStyle(0x84cc16, 1); g.fillCircle(cx, cy, r * 0.66);
  // white-hot core
  g.fillStyle(0xfdfde8, 1); g.fillCircle(cx, cy, r * 0.32);

  g.generateTexture(key, size, size);
  g.destroy();
  return key;
}

// ── The single Phaser scene ───────────────────────────────────────────────────
class ArenaScene extends Phaser.Scene {
  constructor() { super('arena'); }

  init(data) {
    this.onStateChange = data.onStateChange || (() => {});
    this.resumeFrom = data.resumeFrom || { deaths: 0 };
  }

  preload() {
    this.load.image('player', '/mascot_pump.png');
  }

  create() {
    const W = GAME_W, H = GAME_H;

    makeCapsuleTexture(this, 'minion', { w: 64, h: 64, boss: false });
    makeCapsuleTexture(this, 'bossCap', { w: 200, h: 200, boss: true });
    makeCapsuleTexture(this, 'shard', { w: 28, h: 28, boss: false });
    makeFireballTexture(this, 'fireball', 48);

    this.cameras.main.setBackgroundColor('#080808');
    const g = this.add.graphics();
    g.lineStyle(1, 0x84cc16, 0.05);
    for (let x = 0; x <= W; x += 48) g.lineBetween(x, 0, x, H);
    for (let y = 0; y <= H; y += 48) g.lineBetween(0, y, W, y);
    g.fillStyle(0x0e0e0e, 1);
    g.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    g.lineStyle(2, 0x84cc16, 0.35);
    g.lineBetween(0, GROUND_Y, W, GROUND_Y);

    this.physics.world.setBounds(0, 0, W, H);

    this.ground = this.physics.add.staticGroup();
    const groundRect = this.add.rectangle(W / 2, GROUND_Y + (H - GROUND_Y) / 2, W, H - GROUND_Y, 0x000000, 0);
    this.ground.add(groundRect);

    this.platforms = this.physics.add.staticGroup();
    const mkPlat = (x, y, w) => {
      const r = this.add.rectangle(x, y, w, 14, 0x84cc16, 0.18).setStrokeStyle(1, 0x84cc16, 0.5);
      this.platforms.add(r); return r;
    };
    mkPlat(200, GROUND_Y - 100, 160);
    mkPlat(W - 200, GROUND_Y - 100, 160);
    mkPlat(W / 2, GROUND_Y - 180, 180);

    this.player = this.physics.add.image(90, GROUND_Y - 80, 'player');
    this.player.setDisplaySize(56, 56).setCollideWorldBounds(true);
    this.player.body.setSize(40, 50).setOffset(8, 6);
    this.player.setData('hp', PLAYER_MAX_HP);
    this.player.setData('facing', 1);
    this.physics.add.collider(this.player, this.ground);
    this.physics.add.collider(this.player, this.platforms);

    this.minions = this.physics.add.group();
    this.projectiles = this.physics.add.group();   // boss shots
    this.fireballs = this.physics.add.group();      // player shots

    for (let i = 0; i < MINION_COUNT; i++) {
      const mx = Phaser.Math.Between(W * 0.45, W - 60);
      const my = GROUND_Y - 40 - Phaser.Math.Between(0, 160);
      const m = this.minions.create(mx, my, 'minion');
      m.setDisplaySize(46, 46);
      m.body.setSize(38, 38).setOffset(4, 4);
      m.body.setAllowGravity(false);
      m.setData('hp', MINION_HP);
      m.setData('bob', Phaser.Math.FloatBetween(0, Math.PI * 2));
    }

    this.boss = this.physics.add.image(W - 150, GROUND_Y - 110, 'bossCap');
    this.boss.setDisplaySize(150, 150);
    this.boss.body.setSize(110, 120).setOffset(20, 15);
    this.boss.body.setAllowGravity(false);
    this.boss.setCollideWorldBounds(true);
    this.boss.setData('hp', BOSS_MAX_HP);
    this.boss.setVisible(false).setActive(false);
    this.bossAwake = false;
    this.bossDead = false;

    this.stamina = STAMINA_MAX;
    this.deaths = this.resumeFrom.deaths || 0;
    this.phase = 0;
    this.invulnUntil = 0;
    this.dodgingUntil = 0;
    this.parryUntil = 0;
    this.canAttackAt = 0;
    this.jumpsLeft = MAX_JUMPS;
    this.dead = false;
    this.won = false;
    this.runStartMs = this.time.now;
    this.bestTimeMs = null;

    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      a: Phaser.Input.Keyboard.KeyCodes.A, d: Phaser.Input.Keyboard.KeyCodes.D,
      w: Phaser.Input.Keyboard.KeyCodes.W, space: Phaser.Input.Keyboard.KeyCodes.SPACE,
      shift: Phaser.Input.Keyboard.KeyCodes.SHIFT,
      j: Phaser.Input.Keyboard.KeyCodes.J, k: Phaser.Input.Keyboard.KeyCodes.K,
    });

    this.physics.add.overlap(this.player, this.minions, this.onMinionTouch, undefined, this);
    this.physics.add.overlap(this.player, this.projectiles, this.onProjectileHit, undefined, this);
    this.physics.add.overlap(this.player, this.boss, this.onBossTouch, undefined, this);

    // player fireballs hit enemies
    this.physics.add.overlap(this.fireballs, this.minions, this.onFireballMinion, undefined, this);
    this.physics.add.overlap(this.fireballs, this.boss, this.onFireballBoss, undefined, this);

    this.pushState();
  }

  pushState() {
    this.onStateChange({
      hp: Math.max(0, Math.round(this.player.getData('hp'))),
      stamina: Math.max(0, Math.round(this.stamina)),
      bossHp: Math.max(0, Math.round(this.boss.getData('hp'))),
      bossMax: BOSS_MAX_HP,
      bossAwake: this.bossAwake,
      minionsLeft: this.minions.countActive(true),
      deaths: this.deaths,
      phase: this.phase,
      dead: this.dead,
      won: this.won,
      bestTimeMs: this.bestTimeMs,
    });
  }

  onMinionTouch(player, m) {
    if (this.dead || this.won) return;
    if (this.time.now < this.invulnUntil) return;
    this.damagePlayer(MINION_TOUCH_DMG);
    const dir = this.player.x < m.x ? -1 : 1;
    this.player.setVelocity(220 * dir, -180);
  }

  onBossTouch() {
    if (this.dead || this.won || !this.bossAwake) return;
    if (this.time.now < this.invulnUntil) return;
    this.damagePlayer(BOSS_TOUCH_DMG);
    const dir = this.player.x < this.boss.x ? -1 : 1;
    this.player.setVelocity(280 * dir, -200);
  }

  onProjectileHit(player, proj) {
    if (this.dead || this.won) return;
    if (this.time.now < this.invulnUntil) { if (proj.body) proj.body.enable = false; proj.destroy(); return; }
    // PARRY: within the window, reflect the shot back as a player fireball AND
    // stagger the boss wide open. This is the high-skill, high-reward play.
    if (this.time.now < this.parryUntil) {
      const vx = proj.body ? proj.body.velocity.x : 0;
      const vy = proj.body ? proj.body.velocity.y : 0;
      if (proj.body) proj.body.enable = false;
      proj.destroy();
      // spawn a reflected fireball heading back toward the boss
      const fb = this.fireballs.create(this.player.x, this.player.y, 'fireball');
      fb.setDisplaySize(40, 40);
      fb.body.setAllowGravity(false);
      fb.setData('dmg', PARRY_REFLECT_DMG);
      fb.setData('reflected', true);
      // send it back the way it came (reversed), biased toward the boss
      const back = this.boss && this.boss.active
        ? new Phaser.Math.Vector2(this.boss.x - this.player.x, this.boss.y - this.player.y).normalize().scale(FIREBALL_SPEED)
        : new Phaser.Math.Vector2(-vx, -vy);
      fb.setVelocity(back.x, back.y);
      fb.setTint(0x66ddff);
      fb.setData("spin", 9);
      this.time.delayedCall(FIREBALL_LIFETIME_MS, () => { if (fb && fb.active) fb.destroy(); });
      this.cameras.main.flash(120, 100, 220, 255);
      this.staggerBoss();
      return;
    }
    if (proj.body) proj.body.enable = false;
    proj.destroy();
    this.damagePlayer(PROJECTILE_DMG);
  }

  damagePlayer(amount) {
    const hp = this.player.getData('hp') - amount;
    this.player.setData('hp', hp);
    this.cameras.main.shake(110, 0.008);
    this.player.setTint(0xff5555);
    this.time.delayedCall(110, () => { if (!this.dead) this.player.clearTint(); });
    this.invulnUntil = this.time.now + 220;
    if (hp <= 0) this.killPlayer();
    this.pushState();
  }

  killPlayer() {
    if (this.dead) return;
    this.dead = true;
    this.deaths += 1;
    this.player.setVelocity(0, 0);
    this.player.body.enable = false;
    this.player.setTint(0x333333).setAlpha(0.6);
    this.pushState();
    this.time.delayedCall(1100, () => this.respawn());
  }

  respawn() {
    this.dead = false;
    this.player.clearTint().setAlpha(1);
    this.player.body.enable = true;
    this.player.setData('hp', PLAYER_MAX_HP);
    this.stamina = STAMINA_MAX;
    this.player.setPosition(90, GROUND_Y - 80).setVelocity(0, 0);
    this.invulnUntil = this.time.now + 800;
    if (this.bossAwake && !this.bossDead) this.boss.setData('hp', BOSS_MAX_HP);
    this.pushState();
  }

  doAttack() {
    if (this.time.now < this.canAttackAt) return;
    this.canAttackAt = this.time.now + ATTACK_COOLDOWN_MS;
    const facing = this.player.getData('facing');
    const fb = this.fireballs.create(this.player.x + facing * 30, this.player.y, 'fireball');
    fb.setDisplaySize(40, 40);
    fb.body.setAllowGravity(false);
    fb.setData('dmg', null);          // null => use per-target default dmg
    fb.setData('reflected', false);
    fb.setVelocity(facing * FIREBALL_SPEED, 0);
    fb.setData("spin", 7);
    this.time.delayedCall(FIREBALL_LIFETIME_MS, () => { if (fb && fb.active) fb.destroy(); });
    // tiny recoil + muzzle flash
    this.player.setVelocityX(-facing * 60);
    const flash = this.add.circle(this.player.x + facing * 34, this.player.y, 10, 0x84cc16, 0.5);
    this.time.delayedCall(80, () => flash.destroy());
  }

  onFireballMinion(fb, m) {
    if (!fb.active || !m.active) return;
    const dmg = fb.getData('dmg') != null ? fb.getData('dmg') : ATTACK_DMG_MINION;
    if (fb.body) fb.body.enable = false;
    fb.destroy();
    const hp = m.getData('hp') - dmg;
    m.setData('hp', hp);
    m.setTint(0xff6666);
    this.time.delayedCall(60, () => { if (m.active) m.clearTint(); });
    if (hp <= 0) {
      const burst = this.add.circle(m.x, m.y, 6, 0xff7a18, 0.8);
      this.tweens.add({ targets: burst, radius: 32, alpha: 0, duration: 260, onComplete: () => burst.destroy() });
      m.destroy();
      this.checkSwarmCleared();
    }
    this.pushState();
  }

  onFireballBoss(fb, boss) {
    if (!fb.active || !this.bossAwake || this.bossDead) return;
    const dmg = fb.getData('dmg') != null ? fb.getData('dmg') : ATTACK_DMG_BOSS;
    if (fb.body) fb.body.enable = false;
    fb.destroy();
    this.damageBoss(dmg);
  }

  doDodge() {
    if (this.stamina < DODGE_COST || this.time.now < this.dodgingUntil) return;
    this.stamina -= DODGE_COST;
    const facing = this.player.getData('facing');
    this.dodgingUntil = this.time.now + DODGE_DURATION_MS;
    this.invulnUntil = this.time.now + DODGE_IFRAMES_MS;
    this.player.setVelocityX(facing * DODGE_SPEED);
    this.player.setAlpha(0.45);
    this.time.delayedCall(DODGE_IFRAMES_MS, () => { if (!this.dead) this.player.setAlpha(1); });
  }

  doParry() {
    if (this.stamina < PARRY_COST) return;
    this.stamina -= PARRY_COST;
    this.parryUntil = this.time.now + PARRY_WINDOW_MS;
    this.player.setTint(0x66ddff);
    this.time.delayedCall(PARRY_WINDOW_MS, () => { if (!this.dead) this.player.clearTint(); });
  }

  checkSwarmCleared() {
    if (this.phase !== 0) return;
    if (this.minions.countActive(true) === 0) {
      this.phase = 1;
      this.wakeBoss();
    }
  }

  wakeBoss() {
    this.bossAwake = true;
    this.boss.setVisible(true).setActive(true);
    this.boss.clearTint();
    this.boss.setAlpha(1);
    // Capture the display scale set by setDisplaySize and lock it in. We do NOT
    // animate scale here, because a hit landing during the entrance tween would
    // call killTweensOf(boss) and freeze it mid-shrink, leaving the boss tiny or
    // invisible. A flash + shake is enough drama without that fragility.
    this._bossScale = this.boss.scaleX;
    this.cameras.main.flash(260, 80, 0, 0);
    this.cameras.main.shake(400, 0.01);
    this.bossTimer = this.time.addEvent({ delay: 1500, loop: true, callback: this.bossAct, callbackScope: this });
    this.pushState();
  }

  staggerBoss() {
    if (!this.bossAwake || this.bossDead) return;
    // cancel any in-flight lunge tween so its onComplete can't fire mid-stagger
    this.tweens.killTweensOf(this.boss);
    this.boss.setTint(0x66ddff);
    if (this.boss.body) this.boss.setVelocity(0, 0);
    // freeze boss attacks for the stagger duration — wide open to fireballs
    if (this.bossTimer) this.bossTimer.paused = true;
    this.cameras.main.shake(200, 0.006);
    this.time.delayedCall(PARRY_STAGGER_MS, () => {
      if (this.bossDead) return;
      this.boss.clearTint();
      if (this.bossTimer) this.bossTimer.paused = false;
    });
  }

  bossAct() {
    if (this.dead || this.won || this.bossDead || !this.bossAwake) return;
    if (!this.boss || !this.boss.active || !this.boss.body) return;
    const dir = this.player.x < this.boss.x ? -1 : 1;
    this.boss.setFlipX(dir < 0);
    const roll = Phaser.Math.Between(0, 2);

    if (roll === 0) {
      // LUNGE via velocity — NEVER tween .x on an Arcade body; the tween and the
      // physics body fight over position and teleport the boss off-screen. Set a
      // velocity toward the player, then stop after a short burst.
      const targetX = Phaser.Math.Clamp(this.player.x, 100, GAME_W - 100);
      const lungeDir = targetX < this.boss.x ? -1 : 1;
      this.boss.setVelocityX(lungeDir * 520);
      this.time.delayedCall(360, () => {
        if (this.boss && this.boss.active && this.boss.body && !this.bossDead) this.boss.setVelocityX(0);
      });
    } else if (roll === 1) {
      for (let i = -2; i <= 2; i++) {
        const p = this.projectiles.create(this.boss.x, this.boss.y, 'shard');
        p.setDisplaySize(24, 24);
        p.body.setAllowGravity(false);
        p.setVelocity(dir * 300, i * 90);
        p.setData("spin", 5);
        this.time.delayedCall(3000, () => { if (p && p.active) p.destroy(); });
      }
    } else {
      this.boss.setTint(0xffee44);
      this.time.delayedCall(440, () => {
        if (this.bossDead || !this.boss || !this.boss.active || !this.boss.body) return;
        this.boss.clearTint();
        [-1, 1].forEach(s => {
          const p = this.projectiles.create(this.boss.x, GROUND_Y - 24, 'shard');
          p.setDisplaySize(30, 22).setTint(0xff3344);
          p.body.setAllowGravity(false);
          p.setVelocity(s * 440, 0);
          p.setData("spin", 9);
          this.time.delayedCall(2500, () => { if (p && p.active) p.destroy(); });
        });
      });
    }
  }

  damageBoss(amount) {
    if (this.bossDead) return;
    const hp = this.boss.getData('hp') - amount;
    this.boss.setData('hp', hp);
    // Red hit-flash. NOTE: do NOT use setTint(0xffffff) here — pure-white tint on
    // a generateTexture sprite can render transparent on some WebGL drivers,
    // which made the boss "vanish on first hit". Red always renders.
    this.boss.setTint(0xff6666);
    this.time.delayedCall(80, () => { if (!this.bossDead && this.boss && this.boss.active) this.boss.clearTint(); });
    if (hp <= 0) this.winFight();
    this.pushState();
  }

  winFight() {
    if (this.won) return;
    this.won = true;
    this.bossDead = true;
    this.phase = 2;
    if (this.bossTimer) this.bossTimer.remove();
    // Kill any in-flight boss tweens (e.g. a lunge) BEFORE we start the death
    // tween — otherwise their onComplete fires on a boss whose body is gone and
    // crashes the game. This was the freeze-on-kill bug.
    this.tweens.killTweensOf(this.boss);
    if (this.boss.body) this.boss.setVelocity(0, 0);
    this.tweens.add({
      targets: this.boss, alpha: 0, angle: 220, scale: (this._bossScale || this.boss.scaleX) * 1.3, duration: 1000,
      onComplete: () => { if (this.boss && this.boss.active) this.boss.setVisible(false); },
    });
    this.bestTimeMs = Math.max(0, Math.round(this.time.now - this.runStartMs));
    this.pushState();
  }

  update(time, delta) {
    if (this.dead) return;
    const dt = delta / 1000;

    if (this.stamina < STAMINA_MAX) this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);

    const onGround = this.player.body.blocked.down || this.player.body.touching.down;
    const dodging = time < this.dodgingUntil;

    // reset air jumps the moment we're grounded
    if (onGround) this.jumpsLeft = MAX_JUMPS;

    if (!dodging) {
      let vx = 0;
      if (this.cursors.left.isDown || this.keys.a.isDown) { vx = -PLAYER_SPEED; this.player.setData('facing', -1); }
      else if (this.cursors.right.isDown || this.keys.d.isDown) { vx = PLAYER_SPEED; this.player.setData('facing', 1); }
      this.player.setVelocityX(vx);
      this.player.setFlipX(this.player.getData('facing') < 0);
    }

    const jumpPressed = Phaser.Input.Keyboard.JustDown(this.cursors.up) ||
                        Phaser.Input.Keyboard.JustDown(this.keys.w) ||
                        Phaser.Input.Keyboard.JustDown(this.keys.space);
    if (jumpPressed && this.jumpsLeft > 0) {
      const isAirJump = !onGround;
      this.player.setVelocityY(isAirJump ? DOUBLE_JUMP_VELOCITY : JUMP_VELOCITY);
      this.jumpsLeft -= 1;
      if (isAirJump) {
        // little lime puff on the air jump for feedback
        const puff = this.add.circle(this.player.x, this.player.y + 24, 8, 0x84cc16, 0.4);
        this.tweens.add({ targets: puff, radius: 22, alpha: 0, duration: 220, onComplete: () => puff.destroy() });
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.shift)) this.doDodge();
    if (Phaser.Input.Keyboard.JustDown(this.keys.j)) this.doAttack();
    if (Phaser.Input.Keyboard.JustDown(this.keys.k)) this.doParry();

    this.minions.getChildren().forEach((m) => {
      if (!m || !m.active) return;
      const dirx = Math.sign(this.player.x - m.x) || 1;
      m.setVelocityX(dirx * MINION_SPEED);
      const bob = m.getData('bob') + dt * 3;
      m.setData('bob', bob);
      const targetY = Phaser.Math.Clamp(this.player.y - 10, 80, GROUND_Y - 30);
      m.y += Math.sign(targetY - m.y) * 30 * dt + Math.sin(bob) * 0.6;
      m.setFlipX(dirx < 0);
      m.rotation = Math.sin(bob) * 0.12;
    });

    // Visual-only rotation for fireballs and boss shards. We rotate the SPRITE
    // (obj.rotation), never the physics body — Arcade Physics bodies are
    // axis-aligned and rotating a body corrupts overlap checks (was the crash).
    const spin = (obj) => {
      if (!obj || !obj.active) return;
      const s = obj.getData('spin');
      if (s) obj.rotation += s * dt;
    };
    this.fireballs.getChildren().forEach(spin);
    this.projectiles.getChildren().forEach(spin);

    if (!this._lastPush || time - this._lastPush > 100) {
      this._lastPush = time;
      this.pushState();
    }
  }
}

export default function GamePage({ onBack, lang = 'en' }) {
  const account = useCurrentAccount();
  const hostRef = useRef(null);
  const gameRef = useRef(null);
  const sceneRef = useRef(null);

  const [hud, setHud] = useState({
    hp: PLAYER_MAX_HP, stamina: STAMINA_MAX, bossHp: BOSS_MAX_HP, bossMax: BOSS_MAX_HP,
    bossAwake: false, minionsLeft: MINION_COUNT, deaths: 0, phase: 0, dead: false, won: false, bestTimeMs: null,
  });
  const [saveMsg, setSaveMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [resume, setResume] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let best = loadLocal();
      if (account?.address) {
        try {
          const r = await fetch(`${INDEXER_URL}/game-progress/${account.address}`);
          if (r.ok) {
            const remote = await r.json();
            best = { deaths: remote.deaths || 0, bossDefeated: !!remote.bossDefeated, bestTimeMs: remote.bestTimeMs || null };
          }
        } catch {}
      }
      if (!cancelled) setResume(best || { deaths: 0, bossDefeated: false });
    })();
    return () => { cancelled = true; };
  }, [account?.address]);

  useEffect(() => {
    if (resume == null || gameRef.current) return;

    const config = {
      type: Phaser.AUTO, width: GAME_W, height: GAME_H, parent: hostRef.current,
      backgroundColor: '#080808', pixelArt: false,
      physics: { default: 'arcade', arcade: { gravity: { y: GRAVITY_Y }, debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    };
    const game = new Phaser.Game(config);
    gameRef.current = game;

    game.scene.add('arena', ArenaScene, true, {
      resumeFrom: { deaths: resume.deaths || 0 },
      onStateChange: (s) => {
        setHud(s);
        if (s.won || s.phase >= 1) {
          saveLocal({ deaths: s.deaths, bossDefeated: s.won, bestTimeMs: s.bestTimeMs ?? null });
        }
      },
    });
    sceneRef.current = game.scene.getScene('arena');

    return () => {
      try { game.destroy(true); } catch {}
      gameRef.current = null; sceneRef.current = null;
    };
  }, [resume]);

  const saveToWallet = useCallback(async () => {
    if (!account?.address) { setSaveMsg('Connect a wallet first'); return; }
    setSaving(true); setSaveMsg('');
    try {
      const body = {
        wallet: account.address,
        checkpoint: hud.phase,
        deaths: hud.deaths,
        bossDefeated: hud.won,
        bestTimeMs: hud.bestTimeMs ?? null,
        payload: { game: 'pumprun', v: 2 },
      };
      const r = await fetch(`${INDEXER_URL}/game-progress`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaveMsg('Saved to wallet \u2713');
    } catch {
      setSaveMsg('Save failed — progress is still saved locally');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 3500);
    }
  }, [account?.address, hud]);

  const restart = useCallback(() => {
    const g = gameRef.current; if (!g) return;
    const sc = g.scene.getScene('arena');
    if (sc) sc.scene.restart({ resumeFrom: { deaths: hud.deaths }, onStateChange: sc.onStateChange });
  }, [hud.deaths]);

  const hpPct = Math.max(0, Math.min(100, hud.hp));
  const stPct = Math.max(0, Math.min(100, hud.stamina));
  const bossPct = hud.bossMax ? Math.max(0, Math.min(100, (hud.bossHp / hud.bossMax) * 100)) : 0;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={12} /> Back to Home
      </button>

      <div className="max-w-4xl mx-auto space-y-4">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-6 text-center relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative">
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>PUMP RUN</h1>
            <p className="text-xs font-mono text-white/40 mt-1">Cut down the swarm. Wake the thing. Don't get dumped.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-1.5"><Heart size={11} className="text-red-400" /><span className="text-[9px] font-mono text-white/40 tracking-widest">HP</span></div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-red-600 to-red-400 rounded-full transition-all" style={{ width: hpPct + '%' }} /></div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-1.5"><Zap size={11} className="text-lime-400" /><span className="text-[9px] font-mono text-white/40 tracking-widest">STAMINA</span></div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all" style={{ width: stPct + '%' }} /></div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-1.5"><Skull size={11} className="text-white/50" /><span className="text-[9px] font-mono text-white/40 tracking-widest">SWARM</span></div>
            <div className="text-sm font-mono font-bold text-white/80">{hud.minionsLeft}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-1.5"><Trophy size={11} className="text-violet-400" /><span className="text-[9px] font-mono text-white/40 tracking-widest">BOSS</span></div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-violet-600 to-fuchsia-400 rounded-full transition-all" style={{ width: (hud.bossAwake ? bossPct : 0) + '%' }} /></div>
          </div>
        </div>

        <div ref={hostRef} className="rounded-2xl border border-white/10 overflow-hidden bg-[#080808] mx-auto"
          style={{ width: '100%', aspectRatio: GAME_W + ' / ' + GAME_H, maxWidth: GAME_W }} />

        {hud.won && (
          <div className="rounded-xl border border-lime-400/30 bg-lime-950/20 p-4 text-center">
            <p className="text-sm font-mono font-bold text-lime-400">CLEARED. The swarm is ash and the boss is gone.</p>
            <p className="text-[11px] font-mono text-white/40 mt-1">Deaths: {hud.deaths}{hud.bestTimeMs ? ' · Time: ' + (hud.bestTimeMs / 1000).toFixed(1) + 's' : ''}</p>
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="text-[11px] font-mono text-white/45 leading-relaxed">
            <span className="text-white/70">Move</span> A/D ·
            <span className="text-white/70"> Jump / Double Jump</span> W/Space ·
            <span className="text-white/70"> Dodge</span> Shift ·
            <span className="text-white/70"> Fireball</span> J ·
            <span className="text-white/70"> Parry</span> K (reflects + stuns)
          </div>
          <div className="flex items-center gap-2">
            <button onClick={restart} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 text-[11px] font-mono text-white/50 hover:text-white hover:border-white/25 transition-colors">
              <RotateCcw size={12} /> Restart
            </button>
            <button onClick={saveToWallet} disabled={saving || !account?.address}
              className={'flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-mono font-bold transition-colors ' + (account?.address ? 'bg-lime-400 text-black hover:bg-lime-300' : 'bg-white/5 text-white/20 cursor-not-allowed')}>
              <Save size={12} /> {saving ? 'Saving…' : 'Save to wallet'}
            </button>
          </div>
        </div>

        {saveMsg && <div className="text-center text-[11px] font-mono text-white/50">{saveMsg}</div>}
        {!account?.address && <div className="text-center text-[10px] font-mono text-white/30">Progress saves locally. Connect a wallet to carry it across devices.</div>}
      </div>
    </div>
  );
}
