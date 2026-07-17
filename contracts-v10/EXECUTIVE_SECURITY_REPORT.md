# SuiPump Security Report, in Plain Language

Written for a reader with no blockchain or crypto background: an investor, a
community member, a journalist. Every section is meant to be understood by a smart
person who has never used a blockchain. Where a technical word is unavoidable, it is
defined in one line the first time it appears, and there is a full glossary at the end.

Date: 2026-07-17. This covers the code that runs SuiPump's token launches and its
automated trading assistant, as it stands just before the planned outside audit and
mainnet launch. The small notes in parentheses (like this) point to the exact test or
document that proves each claim, so a technical reader can check the work. They do not
change the plain-language meaning.

---

## 1. The one-page summary

**What SuiPump is.** SuiPump is a website where anyone can create a new token (think
of it as a digital coin) and where anyone can buy and sell that token. The price is
set automatically by a piece of software running on a public network called Sui, using
a simple rule: the more people buy, the higher the price goes, and the more people
sell, the lower it goes. That automatic pricing rule is called a "bonding curve." When
a token becomes popular enough, it "graduates" and moves to a regular exchange. SuiPump
also offers an optional automated trading assistant (an "agent") that can trade on your
behalf inside strict limits you set, without you approving every single trade.

**What an attack would mean for your money.** The money at stake is the real currency
(called SUI) that buyers put in when they purchase a token, plus the deposit you hand
to the trading assistant. A successful attack could, in the worst cases, let someone
drain the money that honest buyers put into a token, or let someone quietly print
tokens out of thin air and sell them to real buyers for real money, or run your trading
assistant in ways you never authorized. This report walks through every such danger
that has ever been found in this code.

**The bottom line of this audit, in three sentences.** Every serious money-loss flaw
found in earlier reviews has been fixed and each fix is now backed by an automated test
that proves the attack no longer works. This latest review found no new way for a
stranger on the internet to steal funds; it did raise one serious concern about how
much power a single administrator key held and one way to jam (not steal from) an
optional community feature, and both of those have now been fixed as well, each with
new automated tests. This automated review is a safety pass, not a substitute for the
paid outside audit that is still required before real money is involved: top firms have
missed nine-figure bugs before, so a clean pass means "nothing found here," never
"provably safe."

---

## 2. What could have gone wrong

Each item below is a real danger that was found in this code at some point. For each
one: the attack told as a short story, who would have lost money, how it was found,
what was done about it, and the specific automated test that now proves it cannot
happen. Money-loss dangers come first; the smaller ones follow.

### 2.1 A token creator could have printed unlimited free tokens and sold them to real buyers

**The story.** To create a token, the software gives the creator a temporary "master
key" for that one token (technically a "TreasuryCap," an object that lets its holder
print more of that token). The intended flow prints a fixed supply, then locks that
master key away inside the token forever so no more can ever be printed. The flaw was
that the software did not check the token was empty before locking the key away. A
dishonest creator could print a huge pile of free tokens for themselves first, then
lock the key. Honest buyers would then put real money in, and the creator would sell
their free pile back into the token, walking away with the buyers' money.

**Who loses.** Every honest buyer of that token. This was the most severe kind of flaw:
free money creation that drains real deposits.

**How it was found.** The July 15 automated audit, rated Critical (finding F-1 in
SECURITY_AUDIT_2026-07-15.md).

**How it was fixed.** The software now refuses to create the token unless it starts
completely empty (zero tokens in existence). Because of how the network works, "zero in
existence" means the creator has not printed anything, so there is no free pile to sell.

**The test that proves it.** `test_f1_premint_aborts_launch` creates a token, prints
some tokens first, then tries to launch it, and confirms the launch is rejected.

### 2.2 A stranger could have forced any token to "graduate" early and freeze it

**The story.** Graduation (a token leaving the automatic-pricing stage and moving to a
regular exchange) is supposed to happen only after a token has attracted a large amount
of money. The rule for "how much is enough" depended on the current price of SUI, and
in the old design the person making a purchase got to state that price themselves. By
stating a wildly wrong price, a stranger could trick the software into thinking the
graduation target was tiny, force the token to graduate on almost no money, and thereby
freeze it (once graduated, normal buying and selling stops). The token and most of its
supply would be stuck.

**Who loses.** The token's creator and holders, who lose the ability to trade, for a
griefing cost of a few dollars. Nothing is stolen, but the token is bricked.

**How it was found.** The July 15 audit, rated High (finding F-2). A related smaller
issue (F-8) let the same trick trigger a separate graduation function.

**How it was fixed.** The price is no longer something a buyer can state. It now comes
from a single official source (an "oracle," meaning a trusted feed of outside
information, here the SUI price) that only the administrator can update, and only within
a sane range. If that feed goes quiet, the software safely falls back to a fixed target
and never stops trading. As an extra backstop, the graduation payout refuses to run if
the collected money is implausibly small, so even a bad price reading cannot cause a
cheap graduation to pay out.

**The tests that prove it.** `test_set_sui_price_rejects_below_min` and
`test_set_sui_price_rejects_above_max` confirm the price feed rejects out-of-range
values; `test_graduate_rejects_zero_threshold_fresh_curve` and
`test_claim_graduation_funds_rejects_trivial_reserve` confirm the graduation backstops.

### 2.3 Someone could have hijacked an abandoned token's earnings by voting with the same coins many times

**The story.** SuiPump has a community-rescue feature. If a token's creator disappears
for five days, the community can vote to take over the creator role (which earns a share
of trading fees). Votes are weighted by how many tokens you hold. The flaw was that the
software counted the tokens in your wallet at the moment you voted, but did not lock
them. So an attacker could vote from one wallet, send the same coins to a second wallet,
vote again, and repeat, manufacturing unlimited voting power from a tiny stake. They
could seize the creator role of a token and redirect its entire fee stream to
themselves.

**Who loses.** The token's community and its rightful creator, whose earnings get
captured by someone with almost no real stake.

**How it was found.** The July 15 audit, rated High (finding F-3).

**How it was fixed.** Voting was redesigned. To vote, you now have to place your coins
into a locked box (an "escrow," meaning coins held in trust that you cannot use until
they are released back to you) tied to that specific vote. Think of it as putting your
ballot and your coins into a sealed box together: you get the exact coins back after
counting ends, but while they are in the box you physically cannot move them to a second
wallet to vote again. The network's rules make it impossible for the same coins to be in
two places, so the same stake can never be counted twice.

**The test that proves it.** `test_cto_f3_double_count_impossible` confirms that once
coins are locked in one vote, a second wallet cannot add their weight again.

### 2.4 The community-rescue feature was completely broken and could never run

**The story.** This is not a theft; it is a feature that silently did not work. The
community-takeover proposal was built in a way that could not survive past the single
moment it was created (technically, it was never "shared," so no later transaction could
find it). A real takeover needs the proposal to live across many days and many voters'
transactions. As built, every attempt to start one would simply fail.

**Who loses.** No one loses money. But the only safety valve for rescuing an abandoned
token did not exist, and this also happened to hide the voting flaw in 2.3 (you cannot
double-vote on a proposal that can never start).

**How it was found.** The July 16 internal re-audit, rated Medium and confirmed (finding
F-AC-1 in SECURITY_REAUDIT_2026-07-16.md).

**How it was fixed.** The same redesign described in 2.3 rebuilt the proposal as a
lasting shared record that every later vote and the final count can reach, so the
feature now actually works, and the counting is done with the locked-coin method that
also closes 2.3.

**The test that proves it.** `test_cto_shares_the_object` runs a proposal across
several separate transactions, which the old broken version could never do.

### 2.5 A token with no holders could have been taken over for free

**The story.** After the rescue feature was rebuilt (2.3 and 2.4), a fresh review of it
found a corner case. The vote thresholds are calculated as a percentage of the tokens
held by the public. If a token had zero tokens in public hands (a brand new token, or
one where everyone sold), that percentage became zero, so a takeover needed zero votes.
An attacker could claim the creator role of such a token for free and drain any fees it
had already collected.

**Who loses.** Whoever had unclaimed fees sitting in an abandoned, fully-sold token.

**How it was found.** The July 17 focused re-audit of the rescue feature, rated High and
fixed in the same pass (finding CTO-4.0).

**How it was fixed.** The software now refuses to start a takeover of a token with no
public holders, refuses a zero-value stake, and treats a zero vote target as an
automatic failure.

**The tests that prove it.** `test_cto_propose_zero_circulating_aborts` and
`test_cto_propose_zero_stake_aborts`.

### 2.6 A voter could have rigged the pass-or-fail line at the last second

**The story.** A takeover passes if the votes reach a target ("quorum," meaning the
minimum participation needed for a vote to count). That target was being recalculated at
the final moment of counting using live numbers that trading can move. Because several
actions can be bundled into one atomic step on this network, an attacker could, in a
single bundled action, trade to shove the target up or down at the exact instant of
counting, flipping the result, then undo the trade.

**Who loses.** Either a legitimate takeover is wrongly blocked, or an illegitimate one
is wrongly allowed. No deposit is lost (votes' coins are always returnable), but the
outcome is rigged.

**How it was found.** The July 17 rescue-feature re-audit, rated High and fixed in the
same pass (finding CTO-6.0).

**How it was fixed.** The target is now locked in at the moment the proposal starts and
cannot be moved by later trading. The vote count is compared against that frozen target.

**The test that proves it.** `test_cto_quorum_snapshot_survives_supply_inflation`.

### 2.7 One administrator key held too much power and had to be kept "hot"

**The story.** This was the most important concern from the final review, and it is
about concentration of power rather than a coding mistake. A single master
administrator key (a "capability," meaning an object whose holder is allowed to perform
privileged actions) controlled almost everything: it published the official SUI price,
it could drain the money from any graduated token and print that token's final batch
for the exchange listing, it could freeze trading on any token, and it could collect
fees. The plan is to protect this key by requiring multiple people to approve its use (a
"multisig," meaning several signatures are needed to act). The problem: the price has to
be republished about every five minutes, forever, which means the key that does it has
to be constantly available online (a "hot" key). A key that several humans must approve
cannot realistically sign something every five minutes. So either the key stayed online
and a single point of failure controlled the treasury, or price updates stopped and a
feature went dormant. If an attacker stole that always-online key, they could have
drained every graduated token and printed tokens.

**Who loses.** In the worst case, everyone with money in graduated tokens, if that one
key were stolen. This required stealing an internal key, not just visiting the website,
so it is a concentration-of-power risk rather than an open-door bug.

**How it was found.** The July 17 final pre-publish review, rated High and confirmed by
a second reviewer whose job was to disprove it (finding E-1 in
SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md). It sharpened an earlier, milder note about
administrator power (F-9).

**How it was fixed.** The power was split. The everyday price-updating job now has its
own separate, tiny key whose only ability is to publish a price, and only within the
same safe range as before. That is the key that has to stay online. It can do nothing
else: it cannot drain a token, cannot print tokens, cannot freeze trading, and cannot
collect fees. Those powerful actions stayed with the master key, which does not need to
be online every five minutes and can therefore be kept offline under the
multiple-approval scheme. So even if the always-online price key were stolen, the thief
could at most nudge the published price inside its safe band; the treasury is out of
reach (commit 9fcbd6d5, 2026-07-17).

**The tests that prove it.** `test_price_relayer_cap_sets_price` (the new price-only key
works), `test_set_sui_price_gated_on_relayer_cap_only` (the master key can no longer set
the price at all; the old way will not even compile), `test_create_price_config_mints_relayer_cap`
(setup produces exactly one price key), and `test_admin_cap_still_pauses_after_relayer_split`
(the master key's other powers are untouched).

### 2.8 A troublemaker could have repeatedly jammed the community-rescue feature for almost nothing

**The story.** To start a community takeover you must post a small stake, which is meant
to discourage spam. The flaw: the person who started a proposal could immediately
withdraw their own stake in the very next step, while their proposal kept blocking
everyone else from starting a competing one. By starting a proposal and instantly
pulling the stake back, a troublemaker holding just one percent of a token could keep
the rescue feature jammed almost all the time, at only the cost of network fees, with no
money locked up. They could not steal anything; they just denied the rescue feature to
everyone.

**Who loses.** No one loses deposits. The community of an abandoned token loses access
to the rescue feature that exists to help them.

**How it was found.** The July 17 final pre-publish review, rated Medium and confirmed
by a second reviewer whose job was to disprove it (finding PASS-C-1). It made an
earlier, milder note (CTO-2.1) worse, because that earlier note assumed the stake stayed
locked during the blackout, which it did not.

**How it was fixed.** The starter's stake is now locked for the whole life of their
proposal. They can still add extra votes and pull those extra votes back, but the
original stake that lets them block everyone else cannot be withdrawn until the proposal
finishes and is then returned to them in full (it is never taken away, just held). So
jamming the feature now costs the troublemaker their one percent locked up for the
entire multi-day window each time, which removes the "almost free" part that made the
attack worthwhile. Ordinary voters are completely unaffected and can still change their
mind and pull their votes at any time (commit 2b2d764d, 2026-07-17).

**The tests that prove it.** `test_cto_proposer_unvote_below_bond_aborts` (the starter
cannot pull their locked stake early), `test_cto_proposer_unvote_excess_succeeds` (they
can still pull extra votes), `test_cto_proposer_reclaims_bond_after_failed_resolve` and
`test_cto_proposer_reclaims_bond_after_passed_resolve` (they always get the full stake
back afterward, win or lose), and `test_cto_nonproposer_unvote_still_unrestricted`
(ordinary voters keep full freedom).

### 2.9 The smaller issues, briefly

These were found and dealt with; none of them let anyone steal deposits.

- **A fee that was quietly handed back to the buyer.** A small slice of every purchase
  (the portion set aside to seed the future exchange listing) was being refunded to the
  buyer instead of kept. Money was not stolen, but the reserve was slightly underfunded
  and an internal counter was overstated. Fixed so the slice is now kept
  (`test_normal_buy_refund_is_zero_lp_fee_in_reserve`, finding F-5).
- **A math error that silently switched off a feature.** The formula that adjusts the
  graduation target for the SUI price was off by a constant factor of about thirty-two,
  which made the price-adjustment feature never actually take effect. No money at risk;
  it just meant a feature was dormant. Fixed and now tested with real prices
  (`test_published_price_dampens_threshold`, finding F-4).
- **Fake comment authorship.** Anyone could post a comment under a token and label it as
  written by any address they chose, which could be used to impersonate others in the
  comment feed. No money at risk. Fixed so a comment is always labeled with the actual
  sender (`test_comment_author_is_tx_sender`, finding F-7).
- **A misleading test shortcut.** Some tests used a simplified stand-in for the real
  buying logic, which is exactly how the fee and threshold errors above stayed hidden
  behind passing tests. The stand-in was replaced so tests now exercise the real logic
  (finding F-10).

There is also one accepted trade-off worth stating plainly. The trading assistant's
spending limit is a "net" limit, meaning it measures how much is invested at any one
moment, not a lifetime total. If a strategy buys and then sells, the limit frees back up
for the next trade, by design, so a compromised assistant key could, before its expiry,
cycle the deposit through trades rather than being capped at a single lifetime total.
This was accepted as a deliberate design choice because the assistant's key is held
inside protected hardware and each user's key can only ever affect that one user's own
deposit (finding F-6, with the reasoning recorded in AUDIT_NOTES.md).

---

## 3. What still requires trust

No honest system pretends to remove all trust. Here is what you are still trusting today,
stated plainly.

- **The administrator key.** One powerful key can still freeze tokens, move graduated
  tokens' money, and collect fees. As of the July 17 fix (2.7) the everyday price job is
  no longer part of this key, so the powerful key no longer needs to be online all the
  time and can be kept offline. Until it is placed under multiple-approval control you
  are still trusting whoever holds it, and that migration is a stated requirement before
  real-money launch. The separate, online price-only key is deliberately limited: the
  worst its holder can do is nudge the published price within a fixed safe band.
- **The price feed.** The graduation target depends on an official SUI price published
  by the operator through the price-only key above. The operator can only publish a value
  within a sane range, and every update is recorded publicly, but you are trusting them
  to publish honest prices.
- **The outside audit has not happened yet.** The reviews behind this document are
  automated and internal. A paid, independent human audit (the plan names MoveBit) is
  still required before real money is involved and has not yet been done. Automated
  reviews catch a lot, but history shows that even three top firms auditing the same
  code together once missed a bug that cost more than two hundred million dollars.
- **This is testnet, not mainnet.** Everything today runs on a test network using play
  money. The move to the real network ("mainnet") is deliberately gated behind the audit
  and the key migration above. Do not treat testnet behavior as a guarantee for
  real-money behavior.
- **The automated trading assistant's key lives on a server.** By its nature, an
  assistant that trades around the clock without you approving each trade needs a key you
  are not personally holding. That key is kept inside protected hardware, and the network
  rules strictly limit it to trading within your deposit, up to your set limit, until
  your set expiry, and it can never touch your main wallet. But it is a server-held key,
  and the honest description is "scoped and revocable," never "nobody but you could ever
  act."

---

## 4. What we deliberately did not build (and why)

Leaving things out is also a security decision. These were left inert on purpose.

- **The wider "trade anywhere" mode is switched off.** The assistant can, in principle,
  be allowed to trade on outside venues, which is a broader and riskier permission. It is
  turned off by default and requires an explicit, separate opt-in, and the plan is to
  leave it off for the first launch. While off, the assistant can only trade inside
  SuiPump's own tokens, where proceeds always return to your deposit.
- **Some lower-rated community-rescue notes were left as documented decisions, not
  rushed fixes.** Several minor notes about the rescue feature (for example, that a
  takeover of an already-graduated token could redirect its old unclaimed fees, or that
  burned tokens slightly skew the vote math over time) were deliberately not patched.
  They are low-impact, they require unusual conditions, and changing the voting rules is
  an owner decision, so they are written down with recommendations rather than altered
  quietly. The two serious items from the final review (2.7 and 2.8) were the exception:
  they were approved and fixed on July 17 because their impact warranted it.
- **One low-rated timing quirk in the automatic buyback was left documented, not
  patched.** A token's automatic buyback can, in a narrow case, push it just past its
  graduation point without finishing the graduation, which makes purchases temporarily
  bounce until anyone triggers the (permissionless) graduation step. Nothing is lost and
  it self-heals; the fix changes when graduation fires, which is an owner decision, so it
  is documented with a recommendation rather than altered here.
- **The external "orchestrator" trading path was scoped out.** An earlier design routed
  trades through a separate orchestration system. That was set aside for the first
  version in favor of a simpler, more directly controlled path, which reduces the amount
  of code that a first launch has to trust.

---

## 5. Glossary

- **Bonding curve.** The automatic pricing rule: price rises as people buy and falls as
  people sell, with no human setting it.
- **Token.** A digital coin created and traded on SuiPump.
- **SUI.** The real currency of the Sui network, what buyers actually pay with.
- **Graduation.** The point where a popular token leaves SuiPump's automatic pricing and
  moves to a regular exchange.
- **Escrow.** Coins held in trust that you cannot use until they are released back to
  you. Used here so a vote's coins are locked while a vote is live and returned
  afterward.
- **Capability.** An object whose holder is allowed to perform privileged actions. The
  administrator key is a capability; a token's temporary print key is a capability.
- **TreasuryCap (print key).** The specific capability that lets its holder create more
  of one token. SuiPump locks it away inside the token after launch so no more can be
  printed.
- **Oracle.** A trusted feed of outside information used by the software, here the price
  of SUI.
- **Quorum.** The minimum amount of participation a vote needs before it counts.
- **Multisig.** A protection where several separate approvals are required before a
  powerful key can act, so no single person can act alone.
- **Hot key / cold key.** A hot key is kept online and ready to act at any moment; a cold
  key is kept offline for safety. Always-online jobs need hot keys, which are riskier.
- **Mainnet / testnet.** Mainnet is the real network with real money; testnet is a
  practice network with play money. SuiPump is on testnet today.
- **Net spending limit.** A limit on how much the trading assistant can have invested at
  any one moment, which frees back up when it sells, as opposed to a lifetime total.

---

*Accuracy note. Every fix claim above traces to a named automated test, and every
finding traces to a dated report (SECURITY_AUDIT_2026-07-15.md,
SECURITY_REAUDIT_2026-07-16.md, SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md) or to
AUDIT_NOTES.md. The full automated test suite passes at 106 of 106 with no warnings.
This document favors accuracy over reassurance: where something is still open or still
requires trust, it says so.*
