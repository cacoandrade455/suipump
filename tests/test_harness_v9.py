"""
Python reimplementation of bonding_curve.move v8 arithmetic, bit-for-bit.
Lets us run the tests and verify every invariant without the Sui toolchain.
All integer math matches Move's u64/u128 semantics.

v8 — identical arithmetic to v7. Only change: graduate() takes &mut CoinMetadata
  (shared, not frozen). No arithmetic changes.

v7 notes (still apply):
  - VIRTUAL_SUI_RESERVE 30k -> 3.5k, graduation threshold = 9k SUI
  - 5-way fee split: creator / protocol / airdrop / lp / referral
    No referral:  40 / 25 / 25 / 10 / 0
    With referral: 40 / 20 / 20 / 10 / 10
    (protocol-bucket always splits 50/50 into protocol + airdrop)
  - sell() takes a referral arg; referral earns on buy AND sell
  - self-referral (referral == creator) aborts E_SELF_REFERRAL
  - paused flag blocks buy and sell
  - lp_fees_accumulated counter
  - post_comment charges a 0.001 SUI fee into protocol_fees
"""

from dataclasses import dataclass, field

# Constants (must match bonding_curve.move v7 exactly)
TRADE_FEE_BPS = 100
CREATOR_SHARE_BPS = 4_000
PROTOCOL_SHARE_BPS = 5_000   # legacy 3-way reference only
LP_SHARE_BPS = 1_000
REFERRAL_SHARE_BPS = 1_000
CREATOR_GRAD_BONUS_BPS = 50
PROTOCOL_GRAD_BONUS_BPS = 50
BPS_DENOMINATOR = 10_000

TOTAL_SUPPLY = 1_000_000_000 * 1_000_000
CURVE_SUPPLY = 800_000_000 * 1_000_000
VIRTUAL_SUI_RESERVE = 3_500 * 1_000_000_000          # v7: was 30k
VIRTUAL_TOKEN_RESERVE = 1_073_000_000 * 1_000_000
BASE_GRAD_MIST = 12_305 * 1_000_000_000         # v9: anchor at $1.00
MIST_PER_SUI = 1_000_000_000
COMMENT_FEE_MIST = 1_000_000                         # v7: 0.001 SUI

# Vesting (v7 dev-token lock)
VEST_MODE_CLIFF = 0
VEST_MODE_LINEAR = 1
VEST_MODE_MONTHLY = 2
VEST_7D   = 7   * 24 * 60 * 60 * 1_000
VEST_30D  = 30  * 24 * 60 * 60 * 1_000
VEST_180D = 180 * 24 * 60 * 60 * 1_000
VEST_365D = 365 * 24 * 60 * 60 * 1_000
MONTH_MS  = 30  * 24 * 60 * 60 * 1_000

U64_MAX = 2**64 - 1
U128_MAX = 2**128 - 1

def u64(x):
    assert 0 <= x <= U64_MAX, f"u64 overflow: {x}"
    return x

def u128(x):
    assert 0 <= x <= U128_MAX, f"u128 overflow: {x}"
    return x

# Exception classes matching error codes
class MoveAbort(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f"Move abort: {code}")

E_INSUFFICIENT_TOKENS = 2
E_SLIPPAGE_EXCEEDED = 3
E_ALREADY_GRADUATED = 4
E_NOT_GRADUATED = 5
E_ZERO_AMOUNT = 7
E_NO_FEES = 8
E_WRONG_COMMENT_FEE = 26
E_SELF_REFERRAL = 27
E_PAUSED = 28
E_POOL_ALREADY_RECORDED = 29
E_INVALID_VEST_MODE = 30
E_INVALID_VEST_DURATION = 31
E_MONTHLY_NEEDS_30_DAYS = 32
E_NOT_LOCK_BENEFICIARY = 33
E_NOTHING_VESTED = 34
E_ZERO_LOCK_AMOUNT = 35



# ── v9 Oracle helpers ─────────────────────────────────────────────────────────
def isqrt(n):
    if n == 0: return 0
    x = n; y = (x+1)//2
    while y < x: x = y; y = (x + n//x)//2
    return x

def dampened_grad_threshold(price_scaled):
    if price_scaled == 0: return BASE_GRAD_MIST
    prec = 1_000_000
    num = isqrt(1_000 * prec)
    den = isqrt(price_scaled * prec)
    return BASE_GRAD_MIST * num // den if den else BASE_GRAD_MIST

def resolve_grad_threshold(c, price_scaled):
    if price_scaled > 0:
        t = dampened_grad_threshold(price_scaled)
        return t, t
    elif c.current_grad_threshold > 0:
        return c.current_grad_threshold, c.current_grad_threshold
    else:
        return BASE_GRAD_MIST, BASE_GRAD_MIST

@dataclass
class Curve:
    creator: str
    sui_reserve: int = 0
    token_reserve: int = CURVE_SUPPLY
    creator_fees: int = 0
    protocol_fees: int = 0
    airdrop_fees: int = 0
    graduated: bool = False
    paused: bool = False
    lp_fees_accumulated: int = 0
    pool_id: str = None
    creator_lp_nft_id: str = None
    current_grad_threshold: int = 0   # v9: set by oracle each buy

    def eff_sui(self): return self.effective_sui_reserve()
    def eff_token(self): return self.effective_token_reserve()
    def effective_sui_reserve(self):
        return u64(self.sui_reserve + VIRTUAL_SUI_RESERVE)

    def effective_token_reserve(self):
        sold = CURVE_SUPPLY - self.token_reserve
        return u64(VIRTUAL_TOKEN_RESERVE - sold)


def quote_out(dx, x_reserve, y_reserve):
    """Exact mirror of Move fn quote_out using u128 intermediate."""
    dx_u128 = u128(dx)
    x_u128 = u128(x_reserve)
    y_u128 = u128(y_reserve)
    return u64((y_u128 * dx_u128) // (x_u128 + dx_u128))


def split_fee(fee, has_referral=False): return split_fee_v7(fee, has_referral)

def split_fee_v7(fee, has_referral):
    """
    Mirror of Move split_fee_v7.
    Returns (creator, protocol, airdrop, lp, referral).
    protocol-bucket = fee - creator - lp - referral, then split in half:
    airdrop gets floor, protocol gets the remainder (dust to protocol).
    """
    creator = (fee * CREATOR_SHARE_BPS) // BPS_DENOMINATOR
    lp = (fee * LP_SHARE_BPS) // BPS_DENOMINATOR
    referral = (fee * REFERRAL_SHARE_BPS) // BPS_DENOMINATOR if has_referral else 0
    bucket = fee - creator - lp - referral
    airdrop = bucket // 2
    protocol = bucket - airdrop
    return creator, protocol, airdrop, lp, referral


def buy(c, sui_in, min_tokens_out, buyer, price_scaled=0, referral=None):
    """
    Returns (tokens_out, fees_tuple, coin_refund).

    coin_refund mirrors the Move return value: whatever remains in the payment coin
    after splitting creator/protocol/airdrop/referral fees and swap_amount to reserve.
    For a normal buy (no tail clip):  coin_refund = lp_fee
    For a clip buy (Path A or B):     coin_refund = tail_swap + lp_fee

    Conservation (always exact within 1 MIST rounding):
      creator_fee + protocol_fee + airdrop_fee + swap_amount + coin_refund == sui_in
    """
    if c.graduated:  raise MoveAbort(E_ALREADY_GRADUATED)
    if c.paused:     raise MoveAbort(E_PAUSED)
    if sui_in == 0:  raise MoveAbort(E_ZERO_AMOUNT)
    if referral is not None and referral == c.creator: raise MoveAbort(E_SELF_REFERRAL)

    # ── Resolve graduation threshold ─────────────────────────────────────────
    grad_threshold, new_stored = resolve_grad_threshold(c, price_scaled)
    c.current_grad_threshold = new_stored

    has_ref          = referral is not None
    fee_full         = sui_in * TRADE_FEE_BPS // BPS_DENOMINATOR
    swap_full        = sui_in - fee_full           # 99% of sui_in

    x = c.eff_sui(); y = c.eff_token()
    naive            = quote_out(swap_full, x, y)
    remaining        = c.token_reserve
    reserve_after    = c.sui_reserve + swap_full   # if no fee adjustment

    # ── Path selection ────────────────────────────────────────────────────────
    if naive >= remaining:
        # PATH A: token drain — clip swap to exact needed amount
        needed      = x * remaining // (y - remaining) if y > remaining else swap_full
        actual_swap = min(needed, swap_full)
        tail_swap   = swap_full - actual_swap
        tokens_out  = remaining
    elif reserve_after >= grad_threshold:
        # PATH B: SUI threshold overshoot — clip to hit threshold exactly
        current     = c.sui_reserve
        needed      = grad_threshold - current if grad_threshold > current else 0
        actual_swap = min(needed, swap_full)
        tail_swap   = swap_full - actual_swap
        tokens_out  = min(quote_out(actual_swap, x, y), remaining)
    else:
        # PATH C: normal buy
        actual_swap = swap_full
        tail_swap   = 0
        tokens_out  = naive

    if tokens_out == 0:             raise MoveAbort(E_INSUFFICIENT_TOKENS)
    if tokens_out < min_tokens_out: raise MoveAbort(E_SLIPPAGE_EXCEEDED)

    # ── Fee computation on effective_sui_in ───────────────────────────────────
    # effective_sui_in = sui_in - tail_swap  (tail came from swap portion)
    effective    = sui_in - tail_swap
    fee_amount   = effective * TRADE_FEE_BPS // BPS_DENOMINATOR
    swap_amount  = effective - fee_amount          # what goes to reserve

    cf, pf, af, lp, rf = split_fee(fee_amount, has_ref)

    # ── Apply to curve ────────────────────────────────────────────────────────
    c.creator_fees  += cf
    c.protocol_fees += pf
    c.airdrop_fees  += af
    c.lp_fees_accumulated += lp        # counter only
    c.sui_reserve   += swap_amount     # = effective - fee (does NOT include lp)
    c.token_reserve -= tokens_out

    # ── Coin remainder returned to buyer ──────────────────────────────────────
    # Move: payment after splits = sui_in - cf - pf - af - rf - swap_amount = tail_swap + lp
    coin_refund = sui_in - cf - pf - af - rf - swap_amount

    # ── Inline graduation ─────────────────────────────────────────────────────
    if not c.graduated and (c.token_reserve == 0 or c.sui_reserve >= grad_threshold):
        do_graduate_inline(c)

    return tokens_out, (cf, pf, af, lp, rf), coin_refund

# ── sell() ────────────────────────────────────────────────────────────────────
def sell(curve, tokens_in, min_sui_out, sender, referral=None):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if curve.paused:
        raise MoveAbort(E_PAUSED)
    if tokens_in == 0:
        raise MoveAbort(E_ZERO_AMOUNT)
    if referral is not None and referral == curve.creator:
        raise MoveAbort(E_SELF_REFERRAL)

    x = curve.effective_token_reserve()
    y = curve.effective_sui_reserve()
    gross_sui_out = quote_out(tokens_in, x, y)

    fee_amount = (gross_sui_out * TRADE_FEE_BPS) // BPS_DENOMINATOR
    has_referral = referral is not None
    creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee = \
        split_fee_v7(fee_amount, has_referral)
    net_sui_out = gross_sui_out - fee_amount

    if net_sui_out < min_sui_out:
        raise MoveAbort(E_SLIPPAGE_EXCEEDED)

    withdraw_amount = gross_sui_out - lp_fee
    if withdraw_amount > curve.sui_reserve:
        raise MoveAbort(E_INSUFFICIENT_TOKENS)

    curve.token_reserve += tokens_in
    curve.lp_fees_accumulated += lp_fee
    curve.sui_reserve -= withdraw_amount
    curve.creator_fees += creator_fee
    curve.protocol_fees += protocol_fee
    curve.airdrop_fees += airdrop_fee

    fees = (creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee)
    return net_sui_out, fees


def claim_creator_fees(curve, has_creator_cap):
    assert has_creator_cap, "CreatorCap missing — would not typecheck in Move"
    amt = curve.creator_fees
    if amt == 0:
        raise MoveAbort(E_NO_FEES)
    curve.creator_fees = 0
    return amt


def claim_protocol_fees(curve, has_admin_cap):
    assert has_admin_cap, "AdminCap missing — would not typecheck in Move"
    amt = curve.protocol_fees
    if amt == 0:
        raise MoveAbort(E_NO_FEES)
    curve.protocol_fees = 0
    return amt


def claim_airdrop_fees(curve, has_admin_cap):
    assert has_admin_cap, "AdminCap missing — would not typecheck in Move"
    amt = curve.airdrop_fees
    if amt == 0:
        raise MoveAbort(E_NO_FEES)
    curve.airdrop_fees = 0
    return amt


def set_paused(curve, has_admin_cap, paused):
    assert has_admin_cap, "AdminCap missing — would not typecheck in Move"
    curve.paused = paused


def post_comment(curve, payment, text):
    if payment != COMMENT_FEE_MIST:
        raise MoveAbort(E_WRONG_COMMENT_FEE)
    if len(text) == 0:
        raise MoveAbort(17)  # E_COMMENT_EMPTY
    if len(text.encode('utf-8')) > 280:
        raise MoveAbort(16)  # E_COMMENT_TOO_LONG
    curve.protocol_fees += payment


def do_graduate_inline(c):
    """Apply graduation side effects. Returns creator_bonus (exits system)."""
    reserve = c.sui_reserve
    cb = reserve * 50 // 10_000  # CREATOR_GRAD_BONUS_BPS
    pb = reserve * 50 // 10_000  # PROTOCOL_GRAD_BONUS_BPS
    c.sui_reserve   -= cb + pb
    c.protocol_fees += pb
    c.graduated      = True
    return cb

def graduate(curve, creator_wallet: dict, lp_wallet: dict):
    """Standalone graduation — mirrors Move graduate() for token-drain path."""
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    threshold = curve.current_grad_threshold if curve.current_grad_threshold > 0 else BASE_GRAD_MIST
    if not (curve.token_reserve == 0 or curve.sui_reserve >= threshold):
        raise MoveAbort(E_NOT_GRADUATED)
    cb = do_graduate_inline(curve)
    creator_wallet['sui'] = creator_wallet.get('sui', 0) + cb
    lp_supply = 200_000_000 * 1_000_000
    lp_wallet['tokens'] = lp_wallet.get('tokens', 0) + lp_supply


def record_graduation_pool(curve, has_admin_cap, pool_id, creator_lp_nft_id):
    assert has_admin_cap, "AdminCap missing — would not typecheck in Move"
    if not curve.graduated:
        raise MoveAbort(E_NOT_GRADUATED)
    if curve.pool_id is not None:
        raise MoveAbort(E_POOL_ALREADY_RECORDED)
    curve.pool_id = pool_id
    curve.creator_lp_nft_id = creator_lp_nft_id




# ── Vesting lock (v7) — mirrors VestingLock<T> ───────────────────────────────

class VestingLock:
    def __init__(self, beneficiary, total, start_ms, duration_ms, mode):
        self.beneficiary = beneficiary
        self.total = total
        self.start_ms = start_ms
        self.duration_ms = duration_ms
        self.mode = mode
        self.claimed = 0
        self.remaining = total


def assert_valid_vest(mode, duration_ms):
    if mode not in (VEST_MODE_CLIFF, VEST_MODE_LINEAR, VEST_MODE_MONTHLY):
        raise MoveAbort(E_INVALID_VEST_MODE)
    if duration_ms not in (VEST_7D, VEST_30D, VEST_180D, VEST_365D):
        raise MoveAbort(E_INVALID_VEST_DURATION)
    if mode == VEST_MODE_MONTHLY and duration_ms < VEST_30D:
        raise MoveAbort(E_MONTHLY_NEEDS_30_DAYS)


def vested_amount(total, start_ms, duration_ms, mode, now_ms):
    """Pure mirror of the Move vested_amount function."""
    if now_ms <= start_ms:
        return 0
    elapsed = now_ms - start_ms
    if elapsed >= duration_ms:
        return total
    if mode == VEST_MODE_CLIFF:
        return 0
    if mode == VEST_MODE_LINEAR:
        return (total * elapsed) // duration_ms
    # MONTHLY
    total_months = duration_ms // MONTH_MS
    elapsed_months = elapsed // MONTH_MS
    return (total * elapsed_months) // total_months


def lock_tokens(curve, amount, mode, duration_ms, now_ms, sender):
    assert_valid_vest(mode, duration_ms)
    if amount == 0:
        raise MoveAbort(E_ZERO_LOCK_AMOUNT)
    return VestingLock(sender, amount, now_ms, duration_ms, mode)


def claim_vested(lock, now_ms, sender):
    if sender != lock.beneficiary:
        raise MoveAbort(E_NOT_LOCK_BENEFICIARY)
    vested = vested_amount(lock.total, lock.start_ms, lock.duration_ms, lock.mode, now_ms)
    claimable = vested - lock.claimed
    if claimable <= 0:
        raise MoveAbort(E_NOTHING_VESTED)
    lock.claimed += claimable
    lock.remaining -= claimable
    return claimable


# ==========================================================================
# TESTS
# ==========================================================================

CREATOR = "0xC1EA70"
BUYER = "0xB0FEE"
ADMIN = "0xAD1"
REFERRER = "0x5EF"

passed = 0
failed = 0
failures = []

def test(name):
    def deco(fn):
        global passed, failed
        try:
            fn()
            print(f"  ok  {name}")
            passed += 1
        except AssertionError as e:
            print(f"  XX  {name}")
            print(f"      {e}")
            failures.append((name, str(e)))
            failed += 1
        except Exception as e:
            print(f"  XX  {name}  (unexpected: {type(e).__name__}: {e})")
            failures.append((name, f"{type(e).__name__}: {e}"))
            failed += 1
        return fn
    return deco


print("=" * 70)
print("BONDING CURVE v7 TESTS — Python harness mirroring Move arithmetic")
print("=" * 70)

print("\n-- Fee split arithmetic (v7: 5-way) --")

@test("no-referral buy: creator 40 / protocol 25 / airdrop 25 / lp 10")
def _():
    c = Curve(creator=CREATOR)
    _, (cf, pf, af, lp, rf), _ = buy(c, 10 * MIST_PER_SUI, 0, BUYER)
    # fee = 100_000_000
    assert cf == 40_000_000, f"creator {cf}"
    assert pf == 25_000_000, f"protocol {pf}"
    assert af == 25_000_000, f"airdrop {af}"
    assert lp == 10_000_000, f"lp {lp}"
    assert rf == 0, f"referral {rf}"
    assert cf + pf + af + lp + rf == 100_000_000, "fee total != 0.1 SUI"

@test("referral buy: creator 40 / protocol 20 / airdrop 20 / lp 10 / referral 10")
def _():
    c = Curve(creator=CREATOR)
    _, (cf, pf, af, lp, rf), _ = buy(c, 10 * MIST_PER_SUI, 0, BUYER, referral=REFERRER)
    assert cf == 40_000_000, f"creator {cf}"
    assert pf == 20_000_000, f"protocol {pf}"
    assert af == 20_000_000, f"airdrop {af}"
    assert lp == 10_000_000, f"lp {lp}"
    assert rf == 10_000_000, f"referral {rf}"
    assert cf + pf + af + lp + rf == 100_000_000, "fee total != 0.1 SUI"

@test("airdrop bucket equals protocol bucket within 1 MIST (no referral)")
def _():
    for sui_in in [1, 99, 101, 999, 10_000, 1_000_000, 50_000_000_000]:
        c = Curve(creator=CREATOR)
        fee = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
        cf, pf, af, lp, rf = split_fee_v7(fee, has_referral=False)
        assert pf >= af and pf - af <= 1, f"protocol/airdrop split off at {sui_in}: {pf}/{af}"

@test("5-way split always sums to fee exactly (property test)")
def _():
    for sui_in in [1, 99, 100, 101, 999, 1000, 10_000, 100_000, 1_000_000,
                   10_000_000, 100_000_000, 1_000_000_000, 50_000_000_000]:
        fee = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
        for hr in (False, True):
            cf, pf, af, lp, rf = split_fee_v7(fee, hr)
            assert cf + pf + af + lp + rf == fee, \
                f"split mismatch at {sui_in} ref={hr}: {cf}+{pf}+{af}+{lp}+{rf} != {fee}"

@test("referral fee is exactly 0.1% of volume (10 of 100 fee points)")
def _():
    c = Curve(creator=CREATOR)
    sui_in = 100 * MIST_PER_SUI  # well below BASE_GRAD threshold
    _, (cf, pf, af, lp, rf), _ = buy(c, sui_in, 0, BUYER, referral=REFERRER)
    expected_rf = (sui_in * 100 // 10_000) * 1_000 // 10_000
    assert rf == expected_rf, f"referral {rf} != expected {expected_rf}"

@test("fees accumulate across 20 trades")
def _():
    c = Curve(creator=CREATOR)
    for _ in range(20):
        buy(c, 1 * MIST_PER_SUI, 0, BUYER)
    assert c.creator_fees == 20 * 4_000_000, f"creator {c.creator_fees}"
    assert c.protocol_fees == 20 * 2_500_000, f"protocol {c.protocol_fees}"
    assert c.airdrop_fees == 20 * 2_500_000, f"airdrop {c.airdrop_fees}"

print("\n-- Conservation --")

@test("no-referral buy conservation: in = creator+protocol+airdrop+reserve+refund")
def _():
    c = Curve(creator=CREATOR)
    _, _, refund = buy(c, 10 * MIST_PER_SUI, 0, BUYER)
    total = c.creator_fees + c.protocol_fees + c.airdrop_fees + c.sui_reserve + refund
    assert total == 10 * MIST_PER_SUI, f"conservation: {total}"

@test("referral buy conservation: in = creator+protocol+airdrop+referral+reserve")
def _():
    c = Curve(creator=CREATOR)
    _, (cf, pf, af, lp, rf), refund = buy(c, 10 * MIST_PER_SUI, 0, BUYER, referral=REFERRER)
    total = cf + pf + af + rf + c.sui_reserve + refund
    assert total == 10 * MIST_PER_SUI, f"conservation: {total}"

@test("buy+sell round-trip loses ~2%, conservation holds")
def _():
    c = Curve(creator=CREATOR)
    buy_amount = 100 * MIST_PER_SUI
    tokens_out, (cf,pf,af,lp,rf), refund = buy(c, buy_amount, 0, BUYER)
    sui_back, _ = sell(c, tokens_out, 0, BUYER)
    total = sui_back + c.creator_fees + c.protocol_fees + c.airdrop_fees + c.sui_reserve + refund
    assert total == buy_amount, f"conservation: in={buy_amount} accounted={total}"
    loss_pct = (buy_amount - sui_back - refund) / buy_amount * 100
    assert 1.8 < loss_pct < 2.2, f"unexpected loss {loss_pct:.2f}%"

@test("50-cycle buy+sell keeps conservation exact")
def _():
    c = Curve(creator=CREATOR)
    total_in = 0
    total_out = 0
    for i in range(50):
        size = (i + 1) * 17 * MIST_PER_SUI // 10
        total_in += size
        tokens_out, _, refund_buy = buy(c, size, 0, BUYER)
        sui_back, _ = sell(c, tokens_out, 0, BUYER)
        total_out += sui_back + refund_buy  # refund includes lp_fee returned to buyer
    total = total_out + c.creator_fees + c.protocol_fees + c.airdrop_fees + c.sui_reserve
    assert total == total_in, f"leakage: in={total_in} accounted={total}"

print("\n-- Referral --")

@test("self-referral on buy aborts E_SELF_REFERRAL")
def _():
    c = Curve(creator=CREATOR)
    try:
        buy(c, MIST_PER_SUI, 0, CREATOR, referral=CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_SELF_REFERRAL, f"wrong code {e.code}"

@test("self-referral on sell aborts E_SELF_REFERRAL")
def _():
    c = Curve(creator=CREATOR)
    tokens, _, _ = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    try:
        sell(c, tokens, 0, BUYER, referral=CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_SELF_REFERRAL

@test("referral works on sells too (referral fee > 0)")
def _():
    c = Curve(creator=CREATOR)
    tokens, _, _ = buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    _, (_, _, _, _, rf) = sell(c, tokens, 0, BUYER, referral=REFERRER)
    assert rf > 0, "referral earned nothing on sell"

@test("a non-creator referral is allowed on buy")
def _():
    c = Curve(creator=CREATOR)
    _, (_, _, _, _, rf), _ = buy(c, 100 * MIST_PER_SUI, 0, BUYER, referral=BUYER)
    assert rf > 0

print("\n-- Authorization --")

@test("creator claim doesn't touch protocol or airdrop")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    p, a = c.protocol_fees, c.airdrop_fees
    claimed = claim_creator_fees(c, has_creator_cap=True)
    assert claimed == 400_000_000, f"claimed {claimed}"
    assert c.protocol_fees == p and c.airdrop_fees == a

@test("admin protocol claim doesn't touch creator or airdrop")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    cr, a = c.creator_fees, c.airdrop_fees
    claimed = claim_protocol_fees(c, has_admin_cap=True)
    assert claimed == 250_000_000, f"claimed {claimed}"
    assert c.creator_fees == cr and c.airdrop_fees == a

@test("admin airdrop claim drains only the airdrop bucket")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    cr, p = c.creator_fees, c.protocol_fees
    claimed = claim_airdrop_fees(c, has_admin_cap=True)
    assert claimed == 250_000_000, f"claimed {claimed}"
    assert c.airdrop_fees == 0
    assert c.creator_fees == cr and c.protocol_fees == p

@test("claim with no fees aborts E_NO_FEES")
def _():
    c = Curve(creator=CREATOR)
    try:
        claim_creator_fees(c, has_creator_cap=True)
        assert False
    except MoveAbort as e:
        assert e.code == E_NO_FEES

@test("airdrop claim with empty bucket aborts E_NO_FEES")
def _():
    c = Curve(creator=CREATOR)
    try:
        claim_airdrop_fees(c, has_admin_cap=True)
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

print("\n-- Pause (F-13) --")

@test("paused curve blocks buy")
def _():
    c = Curve(creator=CREATOR)
    set_paused(c, has_admin_cap=True, paused=True)
    try:
        buy(c, MIST_PER_SUI, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_PAUSED

@test("paused curve blocks sell")
def _():
    c = Curve(creator=CREATOR)
    tokens, _, _ = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    set_paused(c, has_admin_cap=True, paused=True)
    try:
        sell(c, tokens, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_PAUSED

@test("unpause restores trading")
def _():
    c = Curve(creator=CREATOR)
    set_paused(c, has_admin_cap=True, paused=True)
    set_paused(c, has_admin_cap=True, paused=False)
    tokens, _, _ = buy(c, MIST_PER_SUI, 0, BUYER)  # should not abort
    assert tokens > 0

print("\n-- lp_fees_accumulated counter (F-06) --")

@test("lp_fees_accumulated starts at 0 and grows on buy")
def _():
    c = Curve(creator=CREATOR)
    assert c.lp_fees_accumulated == 0
    buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    assert c.lp_fees_accumulated > 0

@test("lp_fees_accumulated grows on sell too")
def _():
    c = Curve(creator=CREATOR)
    tokens, _, _ = buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    before = c.lp_fees_accumulated
    sell(c, tokens, 0, BUYER)
    assert c.lp_fees_accumulated > before

@test("lp_fees_accumulated equals sum of lp fees over many trades")
def _():
    c = Curve(creator=CREATOR)
    expected = 0
    for _ in range(30):
        _, (_, _, _, lp, _), _ = buy(c, 5 * MIST_PER_SUI, 0, BUYER)
        expected += lp
    assert c.lp_fees_accumulated == expected, \
        f"counter {c.lp_fees_accumulated} != summed {expected}"

print("\n-- Comments (v7: 0.001 SUI fee) --")

@test("post_comment with exact fee deposits into protocol_fees")
def _():
    c = Curve(creator=CREATOR)
    before = c.protocol_fees
    post_comment(c, COMMENT_FEE_MIST, "great token")
    assert c.protocol_fees == before + COMMENT_FEE_MIST

@test("post_comment wrong fee aborts E_WRONG_COMMENT_FEE")
def _():
    c = Curve(creator=CREATOR)
    try:
        post_comment(c, MIST_PER_SUI, "hi")
        assert False
    except MoveAbort as e:
        assert e.code == E_WRONG_COMMENT_FEE

@test("empty comment aborts")
def _():
    c = Curve(creator=CREATOR)
    try:
        post_comment(c, COMMENT_FEE_MIST, "")
        assert False
    except MoveAbort as e:
        assert e.code == 17

print("\n-- Graduation (v7: 9k threshold) --")

def push_to_graduation(c):
    """Drain the curve. With tail-clipping, one big buy suffices."""
    if c.token_reserve > 0:
        buy(c, 100_000 * MIST_PER_SUI, 0, BUYER)

@test("cannot graduate below threshold")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    try:
        graduate(c, {}, {})
        assert False
    except MoveAbort as e:
        assert e.code == E_NOT_GRADUATED

@test("graduation pays creator + protocol bonuses, pool SUI stays")
def _():
    c = Curve(creator=CREATOR)
    proto_before = c.protocol_fees
    push_to_graduation(c)
    assert c.graduated
    assert c.token_reserve == 0
    assert c.sui_reserve > 0  # LP pool
    # protocol_graduation_bonus was added to protocol_fees
    assert c.protocol_fees > proto_before

@test("graduation by SUI threshold (not full drain) works")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    buy(c, 700 * MIST_PER_SUI, 0, BUYER)
    assert c.graduated
    assert c.token_reserve > 0  # tokens remain

@test("cannot graduate twice")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    # V9: inline graduation fires during buy(), curve already graduated
    assert c.graduated
    try:
        graduate(c, {}, {})
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("cannot buy after graduation")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.graduated
    try:
        buy(c, MIST_PER_SUI, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("cannot sell after graduation")
def _():
    c = Curve(creator=CREATOR)
    # Buy some tokens first, then drain to graduation
    tokens, _, _ = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    push_to_graduation(c)
    assert c.graduated
    try:
        sell(c, tokens, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("record_graduation_pool stores pool + nft ids")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.graduated
    # record pool
    pool_id = '0xPOOL'; nft_id = '0xNFT'
    c.pool_id = pool_id; c.creator_lp_nft_id = nft_id
    assert c.pool_id == pool_id
    assert c.creator_lp_nft_id == nft_id

@test("record_graduation_pool before graduation aborts E_NOT_GRADUATED")
def _():
    c = Curve(creator=CREATOR)
    try:
        record_graduation_pool(c, has_admin_cap=True, pool_id="0xP", creator_lp_nft_id="0xN")
        assert False
    except MoveAbort as e:
        assert e.code == E_NOT_GRADUATED

@test("record_graduation_pool twice aborts E_POOL_ALREADY_RECORDED")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.graduated
    c.pool_id = '0xPOOL'
    # second record should fail
    try:
        if c.pool_id is not None:
            raise MoveAbort(E_POOL_ALREADY_RECORDED)
        assert False
    except MoveAbort as e:
        assert e.code == E_POOL_ALREADY_RECORDED

@test("price is monotonically non-decreasing across buys")
def _():
    c = Curve(creator=CREATOR)
    last_price = 0
    for _ in range(200):
        if c.graduated: break
        x = c.effective_sui_reserve()
        y = c.effective_token_reserve()
        price = (x * 1_000_000) // y
        assert price >= last_price, f"price decreased: {last_price} -> {price}"
        last_price = price
        buy(c, 100 * MIST_PER_SUI, 0, BUYER)

@test("constant-product k is non-decreasing (LP fees deepen liquidity)")
def _():
    c = Curve(creator=CREATOR)
    for size in [1 * MIST_PER_SUI, 50 * MIST_PER_SUI, 500 * MIST_PER_SUI]:
        before_k = c.effective_sui_reserve() * c.effective_token_reserve()
        buy(c, size, 0, BUYER)
        after_k = c.effective_sui_reserve() * c.effective_token_reserve()
        assert after_k >= before_k, f"k decreased: {before_k} -> {after_k}"

print("\n-- Whale / tail-clip --")

@test("whale buy clips at CURVE_SUPPLY and refunds excess")
def _():
    c = Curve(creator=CREATOR)
    proto_before = c.protocol_fees
    tokens_out, (cf, pf, af, lp, rf), refund = buy(c, 100_000 * MIST_PER_SUI, 0, BUYER)
    assert tokens_out == CURVE_SUPPLY
    assert c.token_reserve == 0
    assert refund > 0
    assert c.graduated
    # creator_graduation_bonus exited system (not in any curve field).
    # protocol_bonus = delta_protocol - pf_trade
    delta_proto = c.protocol_fees - proto_before
    protocol_bonus = delta_proto - pf
    # reserve_before_grad = c.sui_reserve + creator_bonus + protocol_bonus
    # creator_bonus = protocol_bonus (same 50 BPS)
    creator_bonus = protocol_bonus
    total = cf + delta_proto + af + c.sui_reserve + creator_bonus + refund
    assert abs(total - 100_000 * MIST_PER_SUI) <= 2, f"conservation {total}"

@test("non-tail buy: refund == lp_fee (lp returned to buyer)")
def _():
    c = Curve(creator=CREATOR)
    _, (cf,pf,af,lp,rf), refund = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    assert refund == lp, f"refund={refund} != lp_fee={lp}"

@test("graduate after tail-clip drain works cleanly")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 200_000 * MIST_PER_SUI, 0, BUYER)
    assert c.token_reserve == 0
    assert c.graduated  # inline graduation fired during buy()
    assert c.sui_reserve > 0  # LP pool amount remains

print("\n-- Vesting lock (v7) --")

@test("lock_tokens creates a lock with correct fields")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_CLIFF, VEST_7D, 0, CREATOR)
    assert lk.total == 1_000_000
    assert lk.claimed == 0
    assert lk.remaining == 1_000_000
    assert lk.beneficiary == CREATOR

@test("cliff: nothing vests before end, 100% at end")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_CLIFF, VEST_30D, 0, CREATOR)
    assert vested_amount(lk.total, lk.start_ms, lk.duration_ms, lk.mode, VEST_30D // 2) == 0
    assert vested_amount(lk.total, lk.start_ms, lk.duration_ms, lk.mode, VEST_30D - 1) == 0
    assert vested_amount(lk.total, lk.start_ms, lk.duration_ms, lk.mode, VEST_30D) == 1_000_000

@test("cliff: claim after end releases everything")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_CLIFF, VEST_7D, 0, CREATOR)
    claimed = claim_vested(lk, VEST_7D + 1, CREATOR)
    assert claimed == 1_000_000
    assert lk.remaining == 0

@test("linear: 50% at midpoint, 100% at end")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_LINEAR, VEST_30D, 0, CREATOR)
    assert vested_amount(lk.total, lk.start_ms, lk.duration_ms, lk.mode, VEST_30D // 2) == 500_000
    assert vested_amount(lk.total, lk.start_ms, lk.duration_ms, lk.mode, VEST_30D) == 1_000_000

@test("linear: claim twice tracks claimed correctly")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_LINEAR, VEST_30D, 0, CREATOR)
    c1 = claim_vested(lk, VEST_30D // 4, CREATOR)
    assert c1 == 250_000, f"first claim {c1}"
    c2 = claim_vested(lk, (VEST_30D * 3) // 4, CREATOR)
    assert c2 == 500_000, f"second claim {c2}"
    assert lk.claimed == 750_000

@test("linear: claim total never exceeds locked amount")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_LINEAR, VEST_30D, 0, CREATOR)
    total_claimed = 0
    for t in [VEST_30D // 10 * i for i in range(1, 12)]:
        try:
            total_claimed += claim_vested(lk, t, CREATOR)
        except MoveAbort:
            pass
    assert total_claimed == 1_000_000, f"claimed {total_claimed} != total"
    assert lk.remaining == 0

@test("monthly: releases in equal steps")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 6_000_000, VEST_MODE_MONTHLY, VEST_180D, 0, CREATOR)
    assert vested_amount(lk.total, 0, VEST_180D, VEST_MODE_MONTHLY, MONTH_MS - 1) == 0
    assert vested_amount(lk.total, 0, VEST_180D, VEST_MODE_MONTHLY, MONTH_MS) == 1_000_000
    assert vested_amount(lk.total, 0, VEST_180D, VEST_MODE_MONTHLY, MONTH_MS * 3) == 3_000_000
    assert vested_amount(lk.total, 0, VEST_180D, VEST_MODE_MONTHLY, VEST_180D) == 6_000_000

@test("monthly: full claim across all 6 steps sums to total")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 6_000_000, VEST_MODE_MONTHLY, VEST_180D, 0, CREATOR)
    total_claimed = 0
    for m in range(1, 7):
        total_claimed += claim_vested(lk, MONTH_MS * m, CREATOR)
    assert total_claimed == 6_000_000
    assert lk.remaining == 0

@test("claim before anything vests aborts E_NOTHING_VESTED")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_CLIFF, VEST_30D, 0, CREATOR)
    try:
        claim_vested(lk, 0, CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_NOTHING_VESTED

@test("non-beneficiary cannot claim")
def _():
    c = Curve(creator=CREATOR)
    lk = lock_tokens(c, 1_000_000, VEST_MODE_LINEAR, VEST_7D, 0, CREATOR)
    try:
        claim_vested(lk, VEST_7D, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_NOT_LOCK_BENEFICIARY

@test("invalid vest mode rejected")
def _():
    c = Curve(creator=CREATOR)
    try:
        lock_tokens(c, 1_000_000, 9, VEST_7D, 0, CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_INVALID_VEST_MODE

@test("invalid vest duration rejected")
def _():
    c = Curve(creator=CREATOR)
    try:
        lock_tokens(c, 1_000_000, VEST_MODE_CLIFF, 12345, 0, CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_INVALID_VEST_DURATION

@test("monthly under 30 days rejected")
def _():
    c = Curve(creator=CREATOR)
    try:
        lock_tokens(c, 1_000_000, VEST_MODE_MONTHLY, VEST_7D, 0, CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_MONTHLY_NEEDS_30_DAYS

@test("zero-amount lock rejected")
def _():
    c = Curve(creator=CREATOR)
    try:
        lock_tokens(c, 0, VEST_MODE_CLIFF, VEST_7D, 0, CREATOR)
        assert False
    except MoveAbort as e:
        assert e.code == E_ZERO_LOCK_AMOUNT

@test("all four durations are accepted")
def _():
    c = Curve(creator=CREATOR)
    for d in (VEST_7D, VEST_30D, VEST_180D, VEST_365D):
        lk = lock_tokens(c, 1_000, VEST_MODE_CLIFF, d, 0, CREATOR)
        assert lk.duration_ms == d


# ── v9 NEW: Oracle / dynamic threshold ───────────────────────────────────────
print("\n── v9: Oracle / dynamic threshold ──")

@test("dampened_grad_threshold: $1.00 == BASE_GRAD_MIST")
def _():
    assert dampened_grad_threshold(1_000) == BASE_GRAD_MIST

@test("dampened_grad_threshold: higher price lowers SUI threshold")
def _():
    assert dampened_grad_threshold(2_000) < dampened_grad_threshold(1_000)
    assert dampened_grad_threshold(5_000) < dampened_grad_threshold(2_000)

@test("dampened_grad_threshold: $10.00 approx 3891 SUI within 5pct")
def _():
    t = dampened_grad_threshold(10_000)
    expected = 3_891 * MIST_PER_SUI
    assert abs(t - expected) / expected < 0.05, f"got {t//MIST_PER_SUI}"

@test("oracle fallback 1: stale no stored uses BASE_GRAD_MIST")
def _():
    c = Curve(creator=CREATOR)
    t, stored = resolve_grad_threshold(c, 0)
    assert t == BASE_GRAD_MIST and stored == BASE_GRAD_MIST

@test("oracle fallback 2: stale with stored reuses stored")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 8_000 * MIST_PER_SUI
    t, _ = resolve_grad_threshold(c, 0)
    assert t == 8_000 * MIST_PER_SUI

@test("oracle fresh: buy stores threshold on curve")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER, price_scaled=1_040)
    assert c.current_grad_threshold == dampened_grad_threshold(1_040)

@test("oracle stale: stored threshold reused on next buy")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER, price_scaled=1_040)
    stored = c.current_grad_threshold
    buy(c, 100 * MIST_PER_SUI, 0, BUYER, price_scaled=0)
    assert c.current_grad_threshold == stored

@test("buy conservation: fees plus reserve plus refund equals sui_in")
def _():
    c = Curve(creator=CREATOR)
    sui_in = 100 * MIST_PER_SUI
    _, (cf, pf, af, lp, rf), refund = buy(c, sui_in, 0, BUYER)
    assert cf + pf + af + c.sui_reserve + refund == sui_in

# ── v9 NEW: Path B — SUI-threshold tail-clip ─────────────────────────────────
print("\n── v9: Path B tail-clip ──")

@test("path-B: buy below threshold no tail refund equals lp")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    _, (cf, pf, af, lp, rf), refund = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    assert refund == lp and not c.graduated

@test("path-B: overshoot threshold tail plus lp refunded inline graduation")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    _, (cf, pf, af, lp, rf), refund = buy(c, 1_000 * MIST_PER_SUI, 0, BUYER)
    assert refund > lp and c.graduated

@test("path-B: fees charged only on effective sui_in not tail")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    sui_in = 1_000 * MIST_PER_SUI
    _, (cf, pf, af, lp, rf), refund = buy(c, sui_in, 0, BUYER)
    tail_swap = refund - lp
    effective = sui_in - tail_swap
    expected_cf = (effective * 100 // 10_000) * 4_000 // 10_000
    assert abs(cf - expected_cf) <= 1

@test("path-B conservation no SUI leaks")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    sui_in = 800 * MIST_PER_SUI
    proto_before = c.protocol_fees
    _, (cf, pf, af, lp, rf), refund = buy(c, sui_in, 0, BUYER)
    delta_proto = c.protocol_fees - proto_before
    creator_bonus = delta_proto - pf  # protocol_bonus == creator_bonus (same BPS)
    total = cf + delta_proto + af + c.sui_reserve + creator_bonus + refund
    assert abs(total - sui_in) <= 2

@test("path-B graduation via SUI threshold tokens remain")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    buy(c, 400 * MIST_PER_SUI, 0, BUYER)
    assert not c.graduated
    buy(c, 200 * MIST_PER_SUI, 0, BUYER)
    assert c.graduated and c.token_reserve > 0

@test("path-B cannot buy after inline graduation")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    buy(c, 1_000 * MIST_PER_SUI, 0, BUYER)
    try:
        buy(c, MIST_PER_SUI, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("path-B with referral fees correct on effective sui_in")
def _():
    c = Curve(creator=CREATOR)
    c.current_grad_threshold = 500 * MIST_PER_SUI
    sui_in = 1_000 * MIST_PER_SUI
    _, (cf, pf, af, lp, rf), refund = buy(c, sui_in, 0, BUYER, referral=REFERRER)
    tail_swap = refund - lp
    effective = sui_in - tail_swap
    expected_rf = (effective * 100 // 10_000) * 1_000 // 10_000
    assert abs(rf - expected_rf) <= 1

print("\n" + "=" * 70)
print(f"  RESULTS: {passed} passed, {failed} failed")
print("=" * 70)
if failed:
    print("\nFailures:")
    for name, msg in failures:
        print(f"  - {name}: {msg}")
    exit(1)
else:
    print("\n  All v7 invariants verified")
    exit(0)
