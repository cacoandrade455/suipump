"""
Python reimplementation of bonding_curve.move v7 arithmetic, bit-for-bit.
Lets us run the tests and verify every invariant without the Sui toolchain.
All integer math matches Move's u64/u128 semantics.

v7 changes from v4 harness:
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
GRAD_THRESHOLD_MIST = 9_000 * 1_000_000_000          # v7
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


def buy(curve, sui_in, min_tokens_out, sender, referral=None):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if curve.paused:
        raise MoveAbort(E_PAUSED)
    if sui_in == 0:
        raise MoveAbort(E_ZERO_AMOUNT)
    if referral is not None and referral == curve.creator:
        raise MoveAbort(E_SELF_REFERRAL)

    fee_amount = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
    has_referral = referral is not None
    creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee = \
        split_fee_v7(fee_amount, has_referral)
    swap_amount = sui_in - fee_amount

    x = curve.effective_sui_reserve()
    y = curve.effective_token_reserve()
    naive_tokens_out = quote_out(swap_amount, x, y)

    # Tail-buy handling: clip to remaining, refund excess.
    remaining = curve.token_reserve
    if naive_tokens_out > remaining:
        needed = u64((u128(x) * u128(remaining)) // (u128(y) - u128(remaining)))
        tokens_out = remaining
        actual_swap = needed
    else:
        tokens_out = naive_tokens_out
        actual_swap = swap_amount

    if tokens_out < min_tokens_out:
        raise MoveAbort(E_SLIPPAGE_EXCEEDED)

    curve.creator_fees += creator_fee
    curve.protocol_fees += protocol_fee
    curve.airdrop_fees += airdrop_fee
    curve.lp_fees_accumulated += lp_fee
    curve.sui_reserve += actual_swap + lp_fee
    curve.token_reserve -= tokens_out

    refund = sui_in - creator_fee - protocol_fee - airdrop_fee \
             - referral_fee - actual_swap - lp_fee
    fees = (creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee)
    return tokens_out, fees, refund


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


def graduate(curve, creator_wallet: dict, lp_wallet: dict):
    """v7 — marks graduated, pays bonuses. Mirrors Move graduate()
    (minus the CoinMetadata freeze, which has no harness equivalent)."""
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if not (curve.token_reserve == 0 or curve.sui_reserve >= GRAD_THRESHOLD_MIST):
        raise MoveAbort(E_NOT_GRADUATED)

    curve.graduated = True
    lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY
    total_reserve = curve.sui_reserve

    creator_bonus = (total_reserve * CREATOR_GRAD_BONUS_BPS) // BPS_DENOMINATOR
    curve.sui_reserve -= creator_bonus
    creator_wallet['sui'] = creator_wallet.get('sui', 0) + creator_bonus

    protocol_bonus = (total_reserve * PROTOCOL_GRAD_BONUS_BPS) // BPS_DENOMINATOR
    curve.sui_reserve -= protocol_bonus
    curve.protocol_fees += protocol_bonus

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
    sui_in = 10_000 * MIST_PER_SUI
    _, (_, _, _, _, rf), _ = buy(c, sui_in, 0, BUYER, referral=REFERRER)
    # 0.1% of volume = sui_in / 1000
    assert rf == sui_in // 1000, f"referral {rf} != {sui_in // 1000}"

@test("fees accumulate across 20 trades")
def _():
    c = Curve(creator=CREATOR)
    for _ in range(20):
        buy(c, 1 * MIST_PER_SUI, 0, BUYER)
    assert c.creator_fees == 20 * 4_000_000, f"creator {c.creator_fees}"
    assert c.protocol_fees == 20 * 2_500_000, f"protocol {c.protocol_fees}"
    assert c.airdrop_fees == 20 * 2_500_000, f"airdrop {c.airdrop_fees}"

print("\n-- Conservation --")

@test("no-referral buy conservation: in = creator+protocol+airdrop+reserve")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 10 * MIST_PER_SUI, 0, BUYER)
    total = c.creator_fees + c.protocol_fees + c.airdrop_fees + c.sui_reserve
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
    tokens_out, _, _ = buy(c, buy_amount, 0, BUYER)
    sui_back, _ = sell(c, tokens_out, 0, BUYER)
    total = sui_back + c.creator_fees + c.protocol_fees + c.airdrop_fees + c.sui_reserve
    assert total == buy_amount, f"conservation: in={buy_amount} accounted={total}"
    loss_pct = (buy_amount - sui_back) / buy_amount * 100
    assert 1.9 < loss_pct < 2.1, f"expected ~2% loss, got {loss_pct:.3f}%"

@test("50-cycle buy+sell keeps conservation exact")
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
    push_to_graduation(c)
    assert c.token_reserve == 0
    reserve_before = c.sui_reserve
    proto_before = c.protocol_fees
    cw, lw = {}, {}
    graduate(c, cw, lw)
    exp_creator = (reserve_before * CREATOR_GRAD_BONUS_BPS) // BPS_DENOMINATOR
    exp_protocol = (reserve_before * PROTOCOL_GRAD_BONUS_BPS) // BPS_DENOMINATOR
    assert cw.get('sui', 0) == exp_creator
    assert c.protocol_fees == proto_before + exp_protocol
    assert lw.get('tokens', 0) == 200_000_000 * 1_000_000
    assert c.graduated
    assert c.sui_reserve == reserve_before - exp_creator - exp_protocol

@test("graduation by 9k threshold (not full drain) works")
def _():
    c = Curve(creator=CREATOR)
    # buy enough to push sui_reserve past 9k SUI without draining all tokens
    buy(c, 12_000 * MIST_PER_SUI, 0, BUYER)
    assert c.sui_reserve >= GRAD_THRESHOLD_MIST, \
        f"reserve {c.sui_reserve/MIST_PER_SUI:.0f} SUI below 9k threshold"
    graduate(c, {}, {})  # should succeed via threshold branch
    assert c.graduated

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
    tokens, _, _ = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    push_to_graduation(c)
    graduate(c, {}, {})
    try:
        sell(c, tokens, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

print("\n-- record_graduation_pool --")

@test("record_graduation_pool stores pool + nft ids")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    graduate(c, {}, {})
    record_graduation_pool(c, has_admin_cap=True, pool_id="0xP00L", creator_lp_nft_id="0xNFT")
    assert c.pool_id == "0xP00L"
    assert c.creator_lp_nft_id == "0xNFT"

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
    graduate(c, {}, {})
    record_graduation_pool(c, has_admin_cap=True, pool_id="0xP", creator_lp_nft_id="0xN")
    try:
        record_graduation_pool(c, has_admin_cap=True, pool_id="0xP", creator_lp_nft_id="0xN")
        assert False
    except MoveAbort as e:
        assert e.code == E_POOL_ALREADY_RECORDED

print("\n-- Price monotonicity --")

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
    tokens_out, (cf, pf, af, lp, rf), refund = buy(c, 100_000 * MIST_PER_SUI, 0, BUYER)
    assert tokens_out == CURVE_SUPPLY
    assert c.token_reserve == 0
    assert refund > 0
    total = cf + pf + af + rf + c.sui_reserve + refund
    assert total == 100_000 * MIST_PER_SUI, f"conservation {total}"

@test("non-tail buy has zero refund")
def _():
    c = Curve(creator=CREATOR)
    _, _, refund = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    assert refund == 0

@test("graduate after tail-clip drain works cleanly")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 200_000 * MIST_PER_SUI, 0, BUYER)
    assert c.token_reserve == 0
    reserve_before = c.sui_reserve
    proto_before = c.protocol_fees
    cw, lw = {}, {}
    graduate(c, cw, lw)
    creator_bonus = cw.get('sui', 0)
    protocol_bonus = c.protocol_fees - proto_before
    pool_sui = c.sui_reserve
    assert creator_bonus + protocol_bonus + pool_sui == reserve_before
    assert creator_bonus > 0 and protocol_bonus > 0
    assert lw.get('tokens', 0) == 200_000_000 * 1_000_000
    assert c.graduated


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
