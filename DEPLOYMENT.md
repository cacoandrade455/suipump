# SuiPump — deployment log

## v2 — 2026-04-24 (current)

Network: Sui testnet
Chain ID: 69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD
Deployer: 0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
Digest: 3i7wqqZz3FmN27jtrk38db7kTg2foDx1zdoGDu4JiPSN
Gas cost: ~0.059 SUI

Package ID:     0x22839b3e46129a42ebc2518013105bbf91f435e6664640cb922815659985d349
AdminCap:       0x42e4c2b399cd09eec1248551fb6e762c1a06444093c061eef452f5bef6ffc340
Example Curve:  0xe69a7df93bc69c0273f33de152fe6c517ad6ed5ebef8199898d20037a9d258f9
UpgradeCap:     0xd2b7dc2931904c904306c178b5655cd82f1532333900b30f1f6ceb0ebcd03abb

### What changed from v1
- Added CreatorCap transferable ownership object
- Added multi-payout splits (up to 10 recipients, bps must sum to 10000)
- Added create_with_launch_fee() — 2 SUI anti-spam fee
- Added create_and_return() + share_curve() for PTB composability (dev-buy)
- Added update_payouts() — cap holder can reassign splits
- claim_creator_fees() now requires CreatorCap, distributes to all recipients

---

## v1 — 2026-04-22 (retired)

Package ID:     0xd4b4e909d8198165121d82d9a70e74a74287a91a5bf288e23528bfe209f512f1
AdminCap:       0x79cd4dc508a52287968b077727d2e06dcdaf823e206520c4f36f07bbb9e335e3
Example Curve:  0xc6528971169d6e67d8e333ff6da0fb0a95dfe13d96010a019aa9bf66dd6eab61

Note: Old EXMPL tokens in wallet are type-bound to v1 package — worthless but harmless.
