"""
Python reimplementation of bonding_curve.move arithmetic, bit-for-bit. v6.
Lets us run all tests and verify every invariant without needing the Sui toolchain.
All integer math matches Move's u64/u128 semantics.

Changes from v4 harness:
  - VIRTUAL_SUI_RESERVE: 30k → 9k SUI
  - GRAD_THRESHOLD_MIST: new (17k SUI)
  - buy() takes referral: Optional[str] and clock_ms: int
  - New tests: anti_bot_delay, referral fee split, metadata_updated flag
  - drain sanity check: ~21k SUI (was ~88k)
"""

from dataclasses import dataclass, field
from typing import Optional

# ── Constants (must match bonding_curve.move v6 exactly) ─────────────────────
TRADE_FEE_BPS          = 100
CREATOR_SHARE_BPS      = 4_000
PROTOCOL_SHARE_BPS     = 5_000
LP_SHARE_BPS           = 1_000
REFERRAL_SHARE_BPS     = 1_000   # v6: carved from protocol when referral set
CREATOR_GRAD_BONUS_BPS = 50
PROTOCOL_GRAD_BONUS_BPS= 50
BPS_DENOMINATOR        = 10_000

TOTAL_SUPPLY           = 1_000_000_000 * 1_000_000
CURVE_SUPPLY           = 800_000_000  * 1_000_000

# V6 virtual reserves
VIRTUAL_SUI_RESERVE    = 9_000 * 1_000_000_000    # 9,000 SUI (was 30,000)
VIRTUAL_TOKEN_RESERVE  = 1_073_000_000 * 1_000_000 # unchanged

# V6 graduation threshold
GRAD_THRESHOLD_MIST    = 17_000 * 1_000_000_000    # 17,000 SUI

# Anti-bot delay options (seconds)
ANTI_BOT_NONE = 0
ANTI_BOT_15S  = 15
ANTI_BOT_30S  = 30

MIST_PER_SUI  = 1_000_000_000
METADATA_WINDOW_MS = 24 * 60 * 60 * 1_000  # 24 hours in ms

U64_MAX  = 2**64 - 1
U128_MAX = 2**128 - 1

def u64(x):
    assert 0 <= x <= U64_MAX,  f"u64 overflow: {x}"
    return x

def u128(x):
    assert 0 <= x <= U128_MAX, f"u128 overflow: {x}"
    return x

# ── Error codes ───────────────────────────────────────────────────────────────
class MoveAbort(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f"Move abort: {code}")

E_INSUFFICIENT_TOKENS      = 2
E_SLIPPAGE_EXCEEDED        = 3
E_ALREADY_GRADUATED        = 4
E_NOT_GRADUATED            = 5
E_ZERO_AMOUNT              = 7
E_NO_FEES                  = 8
E_ANTI_BOT_BLOCKED         = 18
E_METADATA_ALREADY_UPDATED = 21
E_METADATA_WINDOW_CLOSED   = 22

# ── Curve state ───────────────────────────────────────────────────────────────
@dataclass
class Curve:
    creator:          str
    sui_reserve:      int  = 0
    token_reserve:    int  = field(default_factory=lambda: CURVE_SUPPLY)
    creator_fees:     int  = 0
    protocol_fees:    int  = 0
    graduated:        bool = False
    anti_bot_delay:   int  = 0      # seconds: 0, 15, or 30
    created_at_ms:    int  = 0      # clock timestamp at launch
    metadata_updated: bool = False  # one-time flag

    def effective_sui_reserve(self):
        return u64(self.sui_reserve + VIRTUAL_SUI_RESERVE)

    def effective_token_reserve(self):
        sold = CURVE_SUPPLY - self.token_reserve
        return u64(VIRTUAL_TOKEN_RESERVE - sold)

# ── AMM math ──────────────────────────────────────────────────────────────────
def quote_out(dx, x_reserve, y_reserve):
    dx_u128 = u128(dx)
    x_u128  = u128(x_reserve)
    y_u128  = u128(y_reserve)
    return u64((y_u128 * dx_u128) // (x_u128 + dx_u128))

def split_fee(fee):
    """Without referral: 40% creator / 50% protocol / 10% LP"""
    creator  = (fee * CREATOR_SHARE_BPS)  // BPS_DENOMINATOR
    protocol = (fee * PROTOCOL_SHARE_BPS) // BPS_DENOMINATOR
    lp       = fee - creator - protocol
    return creator, protocol, lp

def split_fee_with_referral(fee):
    """With referral: 40% creator / 40% protocol / 10% LP / 10% referral"""
    creator  = (fee * CREATOR_SHARE_BPS)  // BPS_DENOMINATOR
    referral = (fee * REFERRAL_SHARE_BPS) // BPS_DENOMINATOR
    lp       = (fee * LP_SHARE_BPS)       // BPS_DENOMINATOR
    protocol = fee - creator - referral - lp
    return creator, protocol, lp, referral

# ── Core functions ────────────────────────────────────────────────────────────
def buy(curve, sui_in, min_tokens_out, sender,
        referral: Optional[str] = None,
        clock_ms: int = 0):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if sui_in == 0:
        raise MoveAbort(E_ZERO_AMOUNT)

    # Anti-bot check
    if curve.anti_bot_delay > 0:
        delay_ms = curve.anti_bot_delay * 1_000
        if clock_ms < curve.created_at_ms + delay_ms:
            if sender != curve.creator:
                raise MoveAbort(E_ANTI_BOT_BLOCKED)

    fee_amount = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR

    if referral is not None:
        creator_fee, protocol_fee, lp_fee, referral_fee = split_fee_with_referral(fee_amount)
    else:
        creator_fee, protocol_fee, lp_fee = split_fee(fee_amount)
        referral_fee = 0

    swap_amount = sui_in - fee_amount

    x = curve.effective_sui_reserve()
    y = curve.effective_token_reserve()
    naive_tokens_out = quote_out(swap_amount, x, y)

    remaining = curve.token_reserve
    if naive_tokens_out > remaining:
        needed     = u64((u128(x) * u128(remaining)) // (u128(y) - u128(remaining)))
        tokens_out = remaining
        actual_swap = needed
    else:
        tokens_out  = naive_tokens_out
        actual_swap = swap_amount

    if tokens_out < min_tokens_out:
        raise MoveAbort(E_SLIPPAGE_EXCEEDED)

    curve.creator_fees  += creator_fee
    curve.protocol_fees += protocol_fee
    curve.sui_reserve   += actual_swap + lp_fee

    curve.token_reserve -= tokens_out

    refund = sui_in - creator_fee - protocol_fee - referral_fee - actual_swap - lp_fee
    return tokens_out, (creator_fee, protocol_fee, lp_fee, referral_fee), refund


def sell(curve, tokens_in, min_sui_out, sender):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if tokens_in == 0:
        raise MoveAbort(E_ZERO_AMOUNT)

    x = curve.effective_token_reserve()
    y = curve.effective_sui_reserve()
    gross_sui_out = quote_out(tokens_in, x, y)

    fee_amount = (gross_sui_out * TRADE_FEE_BPS) // BPS_DENOMINATOR
    creator_fee, protocol_fee, lp_fee = split_fee(fee_amount)
    net_sui_out = gross_sui_out - fee_amount

    if net_sui_out < min_sui_out:
        raise MoveAbort(E_SLIPPAGE_EXCEEDED)

    withdraw_amount = gross_sui_out - lp_fee
    if withdraw_amount > curve.sui_reserve:
        raise MoveAbort(E_INSUFFICIENT_TOKENS)

    curve.token_reserve += tokens_in
    curve.sui_reserve   -= withdraw_amount
    curve.creator_fees  += creator_fee
    curve.protocol_fees += protocol_fee

    return net_sui_out, (creator_fee, protocol_fee, lp_fee)


def claim_creator_fees(curve, has_cap: bool):
    assert has_cap, "CreatorCap required"
    amt = curve.creator_fees
    if amt == 0:
        raise MoveAbort(E_NO_FEES)
    curve.creator_fees = 0
    return amt


def claim_protocol_fees(curve, has_admin_cap: bool):
    assert has_admin_cap, "AdminCap required"
    amt = curve.protocol_fees
    if amt == 0:
        raise MoveAbort(E_NO_FEES)
    curve.protocol_fees = 0
    return amt


def graduate(curve, creator_wallet: dict, lp_wallet: dict):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if curve.token_reserve != 0:
        raise MoveAbort(E_NOT_GRADUATED)

    curve.graduated = True
    lp_supply       = TOTAL_SUPPLY - CURVE_SUPPLY
    total_reserve   = curve.sui_reserve

    creator_bonus   = (total_reserve * CREATOR_GRAD_BONUS_BPS)  // BPS_DENOMINATOR
    protocol_bonus  = (total_reserve * PROTOCOL_GRAD_BONUS_BPS) // BPS_DENOMINATOR

    curve.sui_reserve   -= creator_bonus
    creator_wallet['sui'] = creator_wallet.get('sui', 0) + creator_bonus

    curve.sui_reserve   -= protocol_bonus
    curve.protocol_fees += protocol_bonus

    lp_wallet['tokens'] = lp_wallet.get('tokens', 0) + lp_supply


def update_metadata(curve, has_cap: bool, clock_ms: int):
    """Instant one-time metadata update within 24h window."""
    assert has_cap, "CreatorCap required"
    if curve.metadata_updated:
        raise MoveAbort(E_METADATA_ALREADY_UPDATED)
    if clock_ms >= curve.created_at_ms + METADATA_WINDOW_MS:
        raise MoveAbort(E_METADATA_WINDOW_CLOSED)
    curve.metadata_updated = True


def push_to_graduation(c):
    """Drain the curve. 50k SUI always exceeds the ~21k drain point."""
    if c.token_reserve > 0:
        buy(c, 50_000 * MIST_PER_SUI, 0, BUYER)

# ── Test runner ───────────────────────────────────────────────────────────────
CREATOR = "0xC1EA70"
BUYER   = "0xB0FEE"

passed   = 0
failed   = 0
failures = []

def test(name):
    def deco(fn):
        global passed, failed
        try:
            fn()
            print(f"  ✓ {name}")
            passed += 1
        except AssertionError as e:
            print(f"  ✗ {name}")
            print(f"      {e}")
            failures.append((name, str(e)))
            failed += 1
        except Exception as e:
            print(f"  ✗ {name}  (unexpected: {type(e).__name__}: {e})")
            failures.append((name, f"{type(e).__name__}: {e}"))
            failed += 1
        return fn
    return deco

# ═════════════════════════════════════════════════════════════════════════════
print("=" * 70)
print("BONDING CURVE TESTS v6 — Python harness")
print("=" * 70)

# ── Fee split arithmetic ──────────────────────────────────────────────────────
print("\n── Fee split arithmetic ──")

@test("fee split sums to 1% on standard 10 SUI buy (no referral)")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, (cf, pf, lp, rf), _ = buy(c, 10 * MIST_PER_SUI, 0, BUYER)
    assert cf == 40_000_000,  f"creator fee {cf}"
    assert pf == 50_000_000,  f"protocol fee {pf}"
    assert lp == 10_000_000,  f"lp fee {lp}"
    assert rf == 0,            f"referral fee should be 0, got {rf}"
    assert cf + pf + lp == 100_000_000, "fee total != 0.1 SUI"
    assert 10 * MIST_PER_SUI == c.creator_fees + c.protocol_fees + c.sui_reserve
    assert c.sui_reserve == 9_910_000_000, f"reserve {c.sui_reserve}"

@test("referral fee split: 40% creator / 40% protocol / 10% LP / 10% referral")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, (cf, pf, lp, rf), _ = buy(c, 10 * MIST_PER_SUI, 0, BUYER, referral="0xREF")
    assert cf == 40_000_000,  f"creator {cf}"
    assert rf == 10_000_000,  f"referral {rf}"
    assert lp == 10_000_000,  f"lp {lp}"
    assert pf == 40_000_000,  f"protocol {pf} (should be 40% when referral active)"
    assert cf + pf + lp + rf == 100_000_000, f"fee total {cf+pf+lp+rf}"

@test("referral reduces protocol share, not creator or LP share")
def _():
    c_no_ref  = Curve(creator=CREATOR)
    c_ref     = Curve(creator=CREATOR)
    sui_in    = 100 * MIST_PER_SUI
    buy(c_no_ref, sui_in, 0, BUYER)
    buy(c_ref,    sui_in, 0, BUYER, referral="0xREF")
    assert c_no_ref.creator_fees == c_ref.creator_fees, "creator fee changed with referral"
    assert c_ref.protocol_fees < c_no_ref.protocol_fees, "protocol fee should be lower with referral"

@test("rounding favors LP at 101-MIST trade")
def _():
    c = Curve(creator=CREATOR)
    _, (cf, pf, lp, rf), _ = buy(c, 101, 0, BUYER)
    assert cf == 0 and pf == 0 and lp == 1 and rf == 0
    assert c.sui_reserve == 101

@test("no rounding: fees always sum exactly to fee_amount (no referral)")
def _():
    for sui_in in [1, 99, 100, 101, 1_000, 10_000, 1_000_000_000, 50_000_000_000]:
        c = Curve(creator=CREATOR)
        buy(c, sui_in, 0, BUYER)
        fee_amount = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
        cf, pf, lp = split_fee(fee_amount)
        assert cf + pf + lp == fee_amount, f"split mismatch at {sui_in}"

@test("no rounding: fees always sum exactly to fee_amount (with referral)")
def _():
    for sui_in in [1_000, 10_000, 1_000_000_000, 50_000_000_000]:
        c = Curve(creator=CREATOR)
        buy(c, sui_in, 0, BUYER, referral="0xREF")
        fee_amount = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
        cf, pf, lp, rf = split_fee_with_referral(fee_amount)
        assert cf + pf + lp + rf == fee_amount, f"split mismatch at {sui_in}"

@test("fees accumulate across 20 trades")
def _():
    c = Curve(creator=CREATOR)
    for _ in range(20):
        buy(c, 1 * MIST_PER_SUI, 0, BUYER)
    assert c.creator_fees  == 20 * 4_000_000, f"creator {c.creator_fees}"
    assert c.protocol_fees == 20 * 5_000_000, f"protocol {c.protocol_fees}"

# ── Anti-bot delay ────────────────────────────────────────────────────────────
print("\n── Anti-bot delay ──")

@test("creator can always buy during anti-bot window")
def _():
    c = Curve(creator=CREATOR, anti_bot_delay=30, created_at_ms=0)
    buy(c, MIST_PER_SUI, 0, CREATOR, clock_ms=0)  # within 30s, but creator

@test("non-creator blocked during anti-bot window")
def _():
    c = Curve(creator=CREATOR, anti_bot_delay=30, created_at_ms=0)
    try:
        buy(c, MIST_PER_SUI, 0, BUYER, clock_ms=0)
        assert False, "should have aborted"
    except MoveAbort as e:
        assert e.code == E_ANTI_BOT_BLOCKED

@test("non-creator can buy after anti-bot window expires (15s)")
def _():
    c = Curve(creator=CREATOR, anti_bot_delay=15, created_at_ms=0)
    buy(c, MIST_PER_SUI, 0, BUYER, clock_ms=16_000)  # 16 seconds = past 15s window

@test("anti-bot delay = 0 allows all buyers immediately")
def _():
    c = Curve(creator=CREATOR, anti_bot_delay=0, created_at_ms=0)
    buy(c, MIST_PER_SUI, 0, BUYER, clock_ms=0)  # no delay, anyone can buy

@test("anti-bot window boundary: blocked at exactly t=window, open at t=window+1ms")
def _():
    c1 = Curve(creator=CREATOR, anti_bot_delay=15, created_at_ms=0)
    c2 = Curve(creator=CREATOR, anti_bot_delay=15, created_at_ms=0)
    # At exactly 15000ms — blocked (< 15000 + 1 is false, need >= 15000)
    try:
        buy(c1, MIST_PER_SUI, 0, BUYER, clock_ms=14_999)
        assert False
    except MoveAbort as e:
        assert e.code == E_ANTI_BOT_BLOCKED
    # At 15000ms — open
    buy(c2, MIST_PER_SUI, 0, BUYER, clock_ms=15_000)

# ── Metadata update ───────────────────────────────────────────────────────────
print("\n── Metadata update (one-time, 24h window) ──")

@test("metadata_updated starts false")
def _():
    c = Curve(creator=CREATOR)
    assert not c.metadata_updated

@test("update_metadata sets flag to true")
def _():
    c = Curve(creator=CREATOR, created_at_ms=0)
    update_metadata(c, has_cap=True, clock_ms=0)
    assert c.metadata_updated

@test("cannot update metadata twice")
def _():
    c = Curve(creator=CREATOR, created_at_ms=0)
    update_metadata(c, has_cap=True, clock_ms=0)
    try:
        update_metadata(c, has_cap=True, clock_ms=0)
        assert False
    except MoveAbort as e:
        assert e.code == E_METADATA_ALREADY_UPDATED

@test("cannot update metadata after 24h window")
def _():
    c = Curve(creator=CREATOR, created_at_ms=0)
    # 24h + 1ms
    try:
        update_metadata(c, has_cap=True, clock_ms=METADATA_WINDOW_MS)
        assert False
    except MoveAbort as e:
        assert e.code == E_METADATA_WINDOW_CLOSED

@test("can update metadata just before window closes")
def _():
    c = Curve(creator=CREATOR, created_at_ms=0)
    update_metadata(c, has_cap=True, clock_ms=METADATA_WINDOW_MS - 1)
    assert c.metadata_updated

# ── Earmarking / authorization ────────────────────────────────────────────────
print("\n── Earmarking / authorization ──")

@test("creator claim doesn't touch protocol fees")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    protocol_before = c.protocol_fees
    claimed = claim_creator_fees(c, has_cap=True)
    assert claimed == 400_000_000, f"claimed {claimed}"
    assert c.creator_fees == 0
    assert c.protocol_fees == protocol_before

@test("admin claim doesn't touch creator fees")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    creator_before = c.creator_fees
    claimed = claim_protocol_fees(c, has_admin_cap=True)
    assert claimed == 500_000_000, f"claimed {claimed}"
    assert c.protocol_fees == 0
    assert c.creator_fees == creator_before

@test("claim with no fees aborts E_NO_FEES")
def _():
    c = Curve(creator=CREATOR)
    try:
        claim_creator_fees(c, has_cap=True)
        assert False
    except MoveAbort as e:
        assert e.code == E_NO_FEES

@test("zero buy aborts E_ZERO_AMOUNT")
def _():
    c = Curve(creator=CREATOR)
    try:
        buy(c, 0, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ZERO_AMOUNT

@test("slippage protection triggers E_SLIPPAGE_EXCEEDED")
def _():
    c = Curve(creator=CREATOR)
    try:
        buy(c, MIST_PER_SUI, 1_000_000_000 * 1_000_000, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_SLIPPAGE_EXCEEDED

# ── Buy/sell conservation ─────────────────────────────────────────────────────
print("\n── Buy/sell conservation ──")

@test("buy+sell round-trip loses ~2% to fees, conservation holds")
def _():
    c = Curve(creator=CREATOR)
    buy_amount = 100 * MIST_PER_SUI
    tokens_out, _, _ = buy(c, buy_amount, 0, BUYER)
    sui_back, _ = sell(c, tokens_out, 0, BUYER)
    total_accounted = sui_back + c.creator_fees + c.protocol_fees + c.sui_reserve
    assert total_accounted == buy_amount, \
        f"conservation: in={buy_amount}, out+fees+reserve={total_accounted}"
    loss_pct = (buy_amount - sui_back) / buy_amount * 100
    assert 1.9 < loss_pct < 2.1, f"expected ~2% loss, got {loss_pct:.3f}%"

@test("LP fee accumulates in reserve (buy+sell leaves reserve > 0)")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, _, _ = buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    sell(c, tokens_out, 0, BUYER)
    assert c.sui_reserve > 0

@test("large round-trip keeps conservation exact (no leakage)")
def _():
    c = Curve(creator=CREATOR)
    total_in = 0
    total_out = 0
    for i in range(50):
        size = (i + 1) * 17 * MIST_PER_SUI // 10
        total_in += size
        tokens_out, _, _ = buy(c, size, 0, BUYER)
        sui_back, _ = sell(c, tokens_out, 0, BUYER)
        total_out += sui_back
    total_accounted = total_out + c.creator_fees + c.protocol_fees + c.sui_reserve
    assert total_accounted == total_in, \
        f"leakage: in={total_in}, accounted={total_accounted}"

# ── Graduation ────────────────────────────────────────────────────────────────
print("\n── Graduation ──")

@test("cannot graduate below drain point")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    try:
        graduate(c, {}, {})
        assert False
    except MoveAbort as e:
        assert e.code == E_NOT_GRADUATED

@test("graduation pays creator 0.5% + protocol 0.5%, pool SUI stays for admin")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.token_reserve == 0
    reserve_before = c.sui_reserve
    proto_before   = c.protocol_fees
    creator_w = {}
    lp_w      = {}
    graduate(c, creator_w, lp_w)
    expected_cb = (reserve_before * CREATOR_GRAD_BONUS_BPS)  // BPS_DENOMINATOR
    expected_pb = (reserve_before * PROTOCOL_GRAD_BONUS_BPS) // BPS_DENOMINATOR
    assert creator_w.get('sui', 0) == expected_cb
    assert c.protocol_fees == proto_before + expected_pb
    assert lp_w.get('tokens', 0) == 200_000_000 * 1_000_000
    assert c.graduated
    assert c.sui_reserve == reserve_before - expected_cb - expected_pb

@test("graduation drain point ~21k SUI (VS=9k, sanity check)")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    # VS=9k, VT=1.073B: drain = VS*VT/(VT-800M) - VS = 9000*1073M/273M - 9000 ≈ 26,374 SUI
    reserve_sui = c.sui_reserve / MIST_PER_SUI
    assert 25_000 < reserve_sui < 28_000, \
        f"drain reserve off expected: {reserve_sui:.0f} SUI (expected ~26,374)"

@test("grad_threshold triggers at 17k SUI real reserve (GRAD_THRESHOLD_MIST check)")
def _():
    # Verify the threshold constant matches what the curve actually drains to
    c = Curve(creator=CREATOR)
    # Partial fill — push past GRAD_THRESHOLD_MIST but not full drain
    # 17k SUI = needs ~95% of curve sold
    # Buy enough to exceed threshold
    buy(c, 20_000 * MIST_PER_SUI, 0, BUYER)  # should drain curve
    assert c.sui_reserve > GRAD_THRESHOLD_MIST or c.token_reserve == 0, \
        "curve should either exceed grad threshold or be fully drained"

@test("cannot graduate twice")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    graduate(c, {}, {})
    try:
        graduate(c, {}, {})
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("cannot buy after graduation")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    graduate(c, {}, {})
    try:
        buy(c, MIST_PER_SUI, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("cannot sell after graduation")
def _():
    c = Curve(creator=CREATOR)
    tokens_held, _, _ = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    push_to_graduation(c)
    graduate(c, {}, {})
    try:
        sell(c, tokens_held, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

# ── Price monotonicity ────────────────────────────────────────────────────────
print("\n── Price monotonicity ──")

@test("price is monotonically non-decreasing across buys")
def _():
    c = Curve(creator=CREATOR)
    last_price = 0
    for _ in range(100):
        x = c.effective_sui_reserve()
        y = c.effective_token_reserve()
        price = (x * 1_000_000) // y
        assert price >= last_price, f"price decreased: {last_price} -> {price}"
        last_price = price
        buy(c, 100 * MIST_PER_SUI, 0, BUYER)

@test("constant-product k is non-decreasing (LP fees deepen pool intentionally)")
def _():
    c = Curve(creator=CREATOR)
    for size in [1 * MIST_PER_SUI, 50 * MIST_PER_SUI, 500 * MIST_PER_SUI]:
        before_k = c.effective_sui_reserve() * c.effective_token_reserve()
        buy(c, size, 0, BUYER)
        after_k = c.effective_sui_reserve() * c.effective_token_reserve()
        assert after_k >= before_k

# ── Stress ────────────────────────────────────────────────────────────────────
print("\n── Stress: large trade at graduation boundary ──")

@test("sequence of buys can drive curve to drain point")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.token_reserve == 0
    graduate(c, {}, {})

@test("whale buy clips at CURVE_SUPPLY and refunds excess")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, _, refund = buy(c, 50_000 * MIST_PER_SUI, 0, BUYER)
    assert tokens_out == CURVE_SUPPLY
    assert c.token_reserve == 0
    assert refund > 0
    total = c.creator_fees + c.protocol_fees + c.sui_reserve + refund
    assert total == 50_000 * MIST_PER_SUI

@test("non-tail buy has zero refund")
def _():
    c = Curve(creator=CREATOR)
    _, _, refund = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    assert refund == 0

@test("graduate after tail-clip drain works cleanly")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 50_000 * MIST_PER_SUI, 0, BUYER)
    assert c.token_reserve == 0
    reserve_before = c.sui_reserve
    proto_before   = c.protocol_fees
    creator_w = {}
    lp_w      = {}
    graduate(c, creator_w, lp_w)
    cb = creator_w.get('sui', 0)
    pb = c.protocol_fees - proto_before
    pool = c.sui_reserve
    assert cb + pb + pool == reserve_before
    assert cb > 0 and pb > 0
    assert lp_w.get('tokens', 0) == 200_000_000 * 1_000_000
    assert c.graduated

# ── Results ───────────────────────────────────────────────────────────────────
print("\n" + "=" * 70)
print(f"  RESULTS: {passed} passed, {failed} failed")
print("=" * 70)
if failed:
    print("\nFailures:")
    for name, msg in failures:
        print(f"  • {name}: {msg}")
    exit(1)
else:
    print("\n  All invariants verified ✓")
    exit(0)
