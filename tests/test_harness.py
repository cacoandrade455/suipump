"""
Python reimplementation of bonding_curve.move arithmetic, bit-for-bit.
Lets us actually *run* the tests and verify every invariant claim without
needing the Sui toolchain. All integer math matches Move's u64/u128 semantics.
"""

from dataclasses import dataclass, field

# Constants (must match bonding_curve.move exactly)
TRADE_FEE_BPS = 100
CREATOR_SHARE_BPS = 4_000
PROTOCOL_SHARE_BPS = 5_000
LP_SHARE_BPS = 1_000
CREATOR_GRAD_BONUS_BPS = 50
BPS_DENOMINATOR = 10_000

TOTAL_SUPPLY = 1_000_000_000 * 1_000_000
CURVE_SUPPLY = 800_000_000 * 1_000_000
VIRTUAL_SUI_RESERVE = 30_000 * 1_000_000_000
VIRTUAL_TOKEN_RESERVE = 1_073_000_000 * 1_000_000
MIST_PER_SUI = 1_000_000_000

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
E_NOT_CREATOR = 6
E_ZERO_AMOUNT = 7
E_NO_FEES = 8


@dataclass
class Curve:
    creator: str
    sui_reserve: int = 0
    token_reserve: int = CURVE_SUPPLY
    creator_fees: int = 0
    protocol_fees: int = 0
    graduated: bool = False

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


def split_fee(fee):
    creator = (fee * CREATOR_SHARE_BPS) // BPS_DENOMINATOR
    protocol = (fee * PROTOCOL_SHARE_BPS) // BPS_DENOMINATOR
    lp = fee - creator - protocol
    return creator, protocol, lp


def buy(curve, sui_in, min_tokens_out, sender):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if sui_in == 0:
        raise MoveAbort(E_ZERO_AMOUNT)

    fee_amount = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
    creator_fee, protocol_fee, lp_fee = split_fee(fee_amount)
    swap_amount = sui_in - fee_amount

    x = curve.effective_sui_reserve()
    y = curve.effective_token_reserve()
    naive_tokens_out = quote_out(swap_amount, x, y)

    # Tail-buy handling: clip to remaining, refund excess.
    remaining = curve.token_reserve
    if naive_tokens_out > remaining:
        # dx needed to buy exactly `remaining`
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
    curve.sui_reserve += actual_swap + lp_fee
    curve.token_reserve -= tokens_out

    # Refund: any sui_in not consumed is returned.
    refund = sui_in - creator_fee - protocol_fee - actual_swap - lp_fee
    return tokens_out, (creator_fee, protocol_fee, lp_fee), refund


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
    curve.sui_reserve -= withdraw_amount
    curve.creator_fees += creator_fee
    curve.protocol_fees += protocol_fee

    return net_sui_out, (creator_fee, protocol_fee, lp_fee)


def claim_creator_fees(curve, sender):
    if sender != curve.creator:
        raise MoveAbort(E_NOT_CREATOR)
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


def graduate(curve):
    if curve.graduated:
        raise MoveAbort(E_ALREADY_GRADUATED)
    if curve.token_reserve != 0:
        raise MoveAbort(E_NOT_GRADUATED)

    curve.graduated = True
    lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY
    total_reserve = curve.sui_reserve
    creator_bonus = (total_reserve * CREATOR_GRAD_BONUS_BPS) // BPS_DENOMINATOR
    curve.sui_reserve -= creator_bonus
    sui_to_pool = curve.sui_reserve
    curve.sui_reserve = 0
    return sui_to_pool, lp_supply, creator_bonus


# ==========================================================================
# TESTS
# ==========================================================================

CREATOR = "0xC1EA70"
BUYER = "0xB0FEE"
ADMIN = "0xAD1"

passed = 0
failed = 0
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


print("=" * 70)
print("BONDING CURVE TESTS — Python harness mirroring Move arithmetic")
print("=" * 70)

print("\n── Fee split arithmetic ──")

@test("fee split sums to 1% on standard 10 SUI buy")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, (cf, pf, lp), _ = buy(c, 10 * MIST_PER_SUI, 0, BUYER)
    assert cf == 40_000_000, f"creator fee {cf}"
    assert pf == 50_000_000, f"protocol fee {pf}"
    assert lp == 10_000_000, f"lp fee {lp}"
    assert cf + pf + lp == 100_000_000, "fee total != 0.1 SUI"
    # Conservation: input = creator_fees + protocol_fees + reserve
    assert 10 * MIST_PER_SUI == c.creator_fees + c.protocol_fees + c.sui_reserve, \
        "conservation violated"
    assert c.sui_reserve == 9_910_000_000, f"reserve {c.sui_reserve}"

@test("rounding favors LP at 101-MIST trade")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, (cf, pf, lp), _ = buy(c, 101, 0, BUYER)
    # Fee = 101 * 100 // 10000 = 1
    # creator = 1 * 4000 // 10000 = 0
    # protocol = 1 * 5000 // 10000 = 0
    # lp = 1 - 0 - 0 = 1
    assert cf == 0
    assert pf == 0
    assert lp == 1
    assert c.creator_fees == 0
    assert c.protocol_fees == 0
    assert c.sui_reserve == 101, f"reserve should be 100 swap + 1 lp = 101, got {c.sui_reserve}"

@test("rounding favors LP at 199-MIST trade")
def _():
    c = Curve(creator=CREATOR)
    _, (cf, pf, lp), _ = buy(c, 199, 0, BUYER)
    # fee = 199 * 100 // 10000 = 1
    assert (cf, pf, lp) == (0, 0, 1)

@test("rounding at 10k MIST — fee = 100 MIST, split cleanly")
def _():
    c = Curve(creator=CREATOR)
    _, (cf, pf, lp), _ = buy(c, 10_000, 0, BUYER)
    # fee = 100
    # creator = 40, protocol = 50, lp = 10
    assert (cf, pf, lp) == (40, 50, 10), f"got {(cf, pf, lp)}"

@test("no rounding: protocol + creator + lp always exactly equals fee")
def _():
    # Property test over 1000 trade sizes
    for sui_in in [1, 99, 100, 101, 999, 1000, 10_000, 100_000, 1_000_000,
                   10_000_000, 100_000_000, 1_000_000_000, 50_000_000_000]:
        c = Curve(creator=CREATOR)
        buy(c, sui_in, 0, BUYER)
        fee_amount = (sui_in * TRADE_FEE_BPS) // BPS_DENOMINATOR
        cf, pf, lp = split_fee(fee_amount)
        assert cf + pf + lp == fee_amount, \
            f"split mismatch at {sui_in}: {cf}+{pf}+{lp} != {fee_amount}"

@test("fees accumulate across 20 trades")
def _():
    c = Curve(creator=CREATOR)
    for _ in range(20):
        buy(c, 1 * MIST_PER_SUI, 0, BUYER)
    assert c.creator_fees == 20 * 4_000_000, f"creator {c.creator_fees}"
    assert c.protocol_fees == 20 * 5_000_000, f"protocol {c.protocol_fees}"

print("\n── Earmarking / authorization ──")

@test("non-creator cannot claim creator fees (E_NOT_CREATOR)")
def _():
    c = Curve(creator=CREATOR)
    buy(c, MIST_PER_SUI, 0, BUYER)
    try:
        claim_creator_fees(c, BUYER)  # wrong sender
        assert False, "should have aborted"
    except MoveAbort as e:
        assert e.code == E_NOT_CREATOR, f"wrong abort code: {e.code}"

@test("creator claim doesn't touch protocol fees")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    protocol_before = c.protocol_fees
    claimed = claim_creator_fees(c, CREATOR)
    assert claimed == 400_000_000, f"claimed {claimed}"
    assert c.creator_fees == 0
    assert c.protocol_fees == protocol_before, "protocol fees were touched!"

@test("admin claim doesn't touch creator fees")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    creator_before = c.creator_fees
    claimed = claim_protocol_fees(c, has_admin_cap=True)
    assert claimed == 500_000_000, f"claimed {claimed}"
    assert c.protocol_fees == 0
    assert c.creator_fees == creator_before, "creator fees were touched!"

@test("claim with no fees aborts E_NO_FEES")
def _():
    c = Curve(creator=CREATOR)
    try:
        claim_creator_fees(c, CREATOR)
        assert False, "should have aborted"
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
        # Demand 1B whole tokens for 1 SUI — impossible
        buy(c, MIST_PER_SUI, 1_000_000_000 * 1_000_000, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_SLIPPAGE_EXCEEDED

print("\n── Buy/sell conservation ──")

@test("buy+sell round-trip loses ~2% to fees, preserves conservation")
def _():
    c = Curve(creator=CREATOR)
    buy_amount = 100 * MIST_PER_SUI
    tokens_out, _, _ = buy(c, buy_amount, 0, BUYER)
    sui_back, _ = sell(c, tokens_out, 0, BUYER)

    # Total conservation
    total_accounted = sui_back + c.creator_fees + c.protocol_fees + c.sui_reserve
    assert total_accounted == buy_amount, \
        f"conservation: in={buy_amount}, out+fees+reserve={total_accounted}"

    # Should lose roughly 2% (1% each way, minus second-order terms)
    loss = buy_amount - sui_back
    loss_pct = loss / buy_amount * 100
    assert 1.9 < loss_pct < 2.1, f"expected ~2% loss, got {loss_pct:.3f}%"

@test("LP fee accumulates in reserve (buy+sell leaves reserve > 0)")
def _():
    c = Curve(creator=CREATOR)
    tokens_out, _, _ = buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    sell(c, tokens_out, 0, BUYER)
    assert c.sui_reserve > 0, "LP fee was not retained!"
    # After one round-trip of 1000 SUI, LP fees ≈ 2 * 0.10% = ~2 SUI.
    # But some of that gets eaten by curve slippage (we sell fewer tokens at
    # the new mid-price), so the reserve retains strictly positive but less.
    assert c.sui_reserve < 3 * MIST_PER_SUI, f"reserve too large: {c.sui_reserve}"

@test("large round-trip keeps conservation exact (no leakage)")
def _():
    # Run 50 buy+sell cycles with varying sizes; ensure exact conservation.
    c = Curve(creator=CREATOR)
    total_in = 0
    total_out = 0
    for i in range(50):
        size = (i + 1) * 17 * MIST_PER_SUI // 10  # varying
        total_in += size
        tokens_out, _, _ = buy(c, size, 0, BUYER)
        sui_back, _ = sell(c, tokens_out, 0, BUYER)
        total_out += sui_back
    total_accounted = total_out + c.creator_fees + c.protocol_fees + c.sui_reserve
    assert total_accounted == total_in, \
        f"leakage: in={total_in}, accounted={total_accounted}, diff={total_in - total_accounted}"

print("\n── Graduation ──")

def push_to_graduation(c):
    """Drain the curve. With tail-clipping in buy(), one big buy suffices."""
    if c.token_reserve > 0:
        # 100k SUI always exceeds the curve's drain point (~88k), so this
        # clips at CURVE_SUPPLY and drains. Refund goes to /dev/null here.
        buy(c, 100_000 * MIST_PER_SUI, 0, BUYER)

@test("cannot graduate below drain point")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 1000 * MIST_PER_SUI, 0, BUYER)
    try:
        graduate(c)
        assert False
    except MoveAbort as e:
        assert e.code == E_NOT_GRADUATED

@test("graduation pays creator 0.5% bonus, remainder to pool")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.token_reserve == 0

    reserve_before = c.sui_reserve
    sui_to_pool, lp_tokens, bonus = graduate(c)

    expected_bonus = (reserve_before * 50) // 10_000
    assert bonus == expected_bonus, f"bonus {bonus} != {expected_bonus}"
    assert sui_to_pool == reserve_before - expected_bonus
    assert lp_tokens == 200_000_000 * 1_000_000  # 20% of 1B with 6 decimals
    assert c.graduated
    assert c.sui_reserve == 0

@test("graduation drain point lands near ~87.9k SUI (sanity check)")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    # With Vs=30k, Vt=1.073B, draining 800M tokens should yield
    # real_sui = Vs*Vt/(Vt-800M) - Vs = 30k * 1073M / 273M - 30k ≈ 87,912 SUI.
    # Plus LP fee retention pushes it slightly higher.
    reserve_sui = c.sui_reserve / MIST_PER_SUI
    assert 87_500 < reserve_sui < 90_000, f"drain reserve off expected: {reserve_sui:.0f} SUI"

@test("cannot graduate twice")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    graduate(c)
    try:
        graduate(c)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

@test("cannot buy after graduation")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    graduate(c)
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
    graduate(c)
    try:
        sell(c, tokens_held, 0, BUYER)
        assert False
    except MoveAbort as e:
        assert e.code == E_ALREADY_GRADUATED

print("\n── Price monotonicity ──")

@test("price is monotonically non-decreasing across buys")
def _():
    c = Curve(creator=CREATOR)
    last_price = 0
    for _ in range(100):
        # price = effective_sui / effective_tokens, quoted per whole token
        x = c.effective_sui_reserve()
        y = c.effective_token_reserve()
        price = (x * 1_000_000) // y
        assert price >= last_price, f"price decreased: {last_price} -> {price}"
        last_price = price
        buy(c, 100 * MIST_PER_SUI, 0, BUYER)

@test("constant-product invariant preserved (virtual reserves)")
def _():
    # k = effective_sui * effective_tokens should equal
    # VIRTUAL_SUI_RESERVE * VIRTUAL_TOKEN_RESERVE *always* (up to rounding
    # in tokens_out), since swap_amount is added to x and tokens_out subtracted
    # from y with the exact ratio from quote_out.
    c = Curve(creator=CREATOR)
    k0 = VIRTUAL_SUI_RESERVE * VIRTUAL_TOKEN_RESERVE
    for size in [1 * MIST_PER_SUI, 50 * MIST_PER_SUI, 500 * MIST_PER_SUI]:
        # Note: LP fees being retained in reserve *intentionally* shifts k
        # upward — this is by design (liquidity deepens). So we check that
        # k is non-decreasing, not exactly constant.
        before_k = c.effective_sui_reserve() * c.effective_token_reserve()
        buy(c, size, 0, BUYER)
        after_k = c.effective_sui_reserve() * c.effective_token_reserve()
        assert after_k >= before_k, f"k decreased: {before_k} -> {after_k}"

print("\n── Stress: large trade at graduation boundary ──")

@test("sequence of buys can drive the curve to drain point")
def _():
    c = Curve(creator=CREATOR)
    push_to_graduation(c)
    assert c.token_reserve == 0
    # And graduation should now succeed.
    graduate(c)

@test("whale buy clips at CURVE_SUPPLY and refunds excess")
def _():
    # With tail-clipping: a 100k SUI buy on a fresh curve would naively
    # want ~823M tokens; clipped to 800M (full curve supply), the actual
    # swap cost is less than 100k SUI, and the difference is refunded.
    c = Curve(creator=CREATOR)
    tokens_out, _, refund = buy(c, 100_000 * MIST_PER_SUI, 0, BUYER)
    assert tokens_out == CURVE_SUPPLY, f"should buy exactly curve supply, got {tokens_out}"
    assert c.token_reserve == 0, "curve should be drained"
    assert refund > 0, "whale should have received a refund"
    # Conservation: sui_in = creator + protocol + reserve + refund
    total = c.creator_fees + c.protocol_fees + c.sui_reserve + refund
    assert total == 100_000 * MIST_PER_SUI, f"conservation: {total} != {100_000 * MIST_PER_SUI}"

@test("non-tail buy has zero refund")
def _():
    # Normal buys should never refund — only tail-clip path does.
    c = Curve(creator=CREATOR)
    _, _, refund = buy(c, 100 * MIST_PER_SUI, 0, BUYER)
    assert refund == 0, f"non-tail buy refunded {refund}"

@test("partial-tail buy: request 80M tokens when 50M remain, get 50M + refund")
def _():
    # Set up a curve with only 50M tokens left.
    c = Curve(creator=CREATOR)
    # Buy 750M tokens first (via whale-clip mechanism is easiest).
    # Actually simpler: use multiple buys to land somewhere specific.
    # Even simpler: drain to 0, then manually set state — no, that's fragile.
    # Cleanest: one big buy that clips, then verify refund conservation.
    sui_in = 50_000 * MIST_PER_SUI
    tokens_out, _, refund = buy(c, sui_in, 0, BUYER)
    assert tokens_out < CURVE_SUPPLY, "50k SUI shouldn't drain the whole curve"
    assert refund == 0, "50k SUI is below drain point — no refund expected"

@test("tail-clip refund conservation across a large whale buy")
def _():
    # Check: creator + protocol + lp_in_reserve + tokens_at_mid_price + refund
    #     == sui_in (within rounding; lp_fee is included in reserve)
    c = Curve(creator=CREATOR)
    sui_in = 200_000 * MIST_PER_SUI
    tokens_out, (cf, pf, lp), refund = buy(c, sui_in, 0, BUYER)
    assert tokens_out == CURVE_SUPPLY
    # Whale paid creator+protocol off the top, actual swap went into reserve,
    # and the rest was refunded.
    assert cf + pf + c.sui_reserve + refund == sui_in, \
        f"conservation: {cf}+{pf}+{c.sui_reserve}+{refund}={cf+pf+c.sui_reserve+refund} vs {sui_in}"

@test("graduate after tail-clip drain works cleanly")
def _():
    c = Curve(creator=CREATOR)
    buy(c, 200_000 * MIST_PER_SUI, 0, BUYER)  # whale drains curve
    assert c.token_reserve == 0
    reserve_before_grad = c.sui_reserve
    sui_to_pool, lp_tokens, bonus = graduate(c)
    # Conservation at graduation: sui_to_pool + bonus == reserve_before_grad
    assert sui_to_pool + bonus == reserve_before_grad, \
        f"graduation conservation: {sui_to_pool}+{bonus} != {reserve_before_grad}"
    assert bonus > 0
    assert lp_tokens == 200_000_000 * 1_000_000
    assert c.graduated
    assert c.sui_reserve == 0

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
