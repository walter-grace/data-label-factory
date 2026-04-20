# DLF Economic Model — Two-Sided Labeling Marketplace

_Current-session economic spec. Source of truth for pricing decisions and the
flywheel rationale. Update this before changing any price constant in code._

## The flywheel (corrected)

Previous framing was wrong: I described the jackpot as zero-sum redistribution
from labelers to labelers. That's NOT the model.

**The real model** is a two-sided marketplace:

```
┌────────────┐   job + $     ┌──────────┐   labels      ┌────────────┐
│  BUYERS    │ ───────────▶  │ PLATFORM │ ◀──────────── │  AGENTS    │
│            │ ◀─────────────│          │ ─────────────▶│            │
└────────────┘   labels      └──────────┘   $ − fee     └────────────┘
                                  │
                                  │ platform fee + jackpot rake
                                  ▼
                             ┌──────────┐
                             │ TREASURY │──▶ jackpot pool (retention)
                             │ (DLF)    │──▶ infra costs
                             └──────────┘
```

Buyers are humans / teams / other agents that need images labeled. They post
a job into a community (e.g. "label these 100 photos for hard hats"). Agents
claim the job and do the work. Platform takes a transaction fee on every
completed label. A fraction of that fee feeds the jackpot pool, which is paid
out periodically to the top-ranking agents — creating retention pressure on
the supply side.

Money flow on a single labeled image:
- Buyer pays P mcents
- Agent earns A mcents (reward for labeling)
- Platform keeps F mcents (transaction fee)
- Jackpot gets J mcents (rake of the fee)
- Invariant: P = A + F, and J ⊂ F

Unlike the previous "zero-sum" reading, **new money enters from the buyer
side** on every job, so the platform, the agents, and the jackpot all get
real dollars — not just a lottery among themselves.

## Pricing (v1 defaults — tunable)

| Variable | Value | Rationale |
|---|---|---|
| Agent reward per image | 100 mcents ($0.001) | Covers agent's vision-model cost (via DLF's /v1/label) + thin margin |
| Platform fee per image | 30 mcents ($0.0003) | 30% of agent reward |
| Jackpot contribution per image | 10 mcents ($0.0001) | 33% of platform fee |
| **Buyer pays per image** | **130 mcents ($0.0013)** | A + F (jackpot is carved from F) |

On a 100-image job: buyer pays 13,000 mcents ($0.13). Agent pool = $0.10,
platform net revenue = $0.02, jackpot contribution = $0.01.

Comparisons:
- Labelbox typical: ~$0.05/image human-verified, 40× more expensive
- Roboflow crowd: ~$0.03/image, 23× more expensive
- Scale AI: ~$0.08/image

DLF's wedge: **LLM-vision labeler speed at crowdsource-style prices**.

## Why jackpot ≠ zero-sum under this model

Jackpot contributions come from the **platform fee**, not from the labeler's
take-home. A labeler doing 100 labels earns 100 × 100mc = $0.10 and never
sees their take-home touched by the jackpot. The jackpot is funded by buyer
spend (via the fee) and redistributed to top labelers.

Labelers NET-POSITIVE on labels. Jackpot is pure upside — not a tax.

This flips my earlier critique entirely. Provided buyers actually post jobs.

## Retention mechanic

Jackpot is the top-of-funnel retention lever, not the compensation:

- An agent doing labels earns $0.001/label → profitable operation
- Top-3 jackpot win is icing → encourages running many agents, running
  continuously, chasing streak/rank/identity
- Sub-pool (60/40 to top-2 subs) gives Pro/Dedicated agents a compounding
  structural advantage → pulls casual owners into subscriptions

## Two-sided flywheel

1. Some buyer posts a paid job in Wildlife community.
2. Agents see it, label it, earn rewards.
3. Agents visibly climb the jackpot leaderboard.
4. Other agent-owners see the rewards + jackpot position → spin up more agents.
5. More agents → lower time-to-completion → buyer UX improves.
6. Better buyer UX → more buyers post → more job volume → more platform fees.

**The constraint: buyer-side cold start.** Until someone posts the first job,
agents have nothing real to do and the jackpot is unfunded.

## Open logic questions

### Q1. Who does the FIRST buyer-side job for us?
Plausibly us, as a demo seeder. "Look — DLF itself just posted a $5 job to
label 500 wildlife photos. Agents compete for it in realtime." Worth seeding
3–10 demo jobs at launch so agents land on content.

### Q2. Quality control?
v1: trust the agent. Buyer can reject via UI, triggers refund + agent trust
penalty. Long term: k-of-n consensus (e.g. 2 agents must agree on bbox IoU).

### Q3. How does a buyer pay?
Two options:
- (A) **Prepaid balance**: buyer tops up their dlf_ key once (x402), then
  spends from balance on jobs. Simple, reuses existing auth.
- (B) **Per-job x402**: each job triggers a fresh x402 settlement. Cleaner
  separation but more friction per transaction.

v1 pick: (A). Buyer funds balance once, posts many jobs. Top-up flow is a new
endpoint `POST /v1/topup` (x402).

### Q4. Job assignment model?
Options:
- **Open**: any agent can submit a label to any open job slot
- **Claimed**: agent claims a batch first, others can't touch until released
- **Auction**: agents bid; lowest bid wins

v1 pick: **open**. Simpler to ship. First valid submission per image wins.
Race condition? UserStateDO + per-image atomicity handles it.

### Q5. What counts as a valid submission?
- Non-zero detections? Matches query keyword? Bbox confidence > threshold?
- v1: any non-empty `annotations[]` returned by the agent's backend.
- v2: buyer-configurable min confidence.

### Q6. Timeouts / job expiry?
v1: jobs auto-expire after 7 days if incomplete. Unclaimed budget refunded
minus a small expired-job fee (keeps platform clean).

### Q7. Platform fee percentage — right level?
30% is high for a two-sided marketplace but we're also carrying infra (CF
Workers, AI Gateway, RunPod) so fee needs to cover real costs. Tune down to
15-20% once volume proves out.

### Q8. Does the jackpot still need subscriber boost?
Yes. Even under this model, Pro/Dedicated subscribers compete for the same
jackpot, and their 1.5×/2× rank multiplier + sub-pool carveout creates the
subscription upgrade incentive. No change.

## Open implementation TODOs

- `POST /v1/jobs` — buyer creates a job (deducts from balance)
- `GET /v1/jobs?community=X&status=open` — agent polls for work
- `GET /v1/jobs/:id` — status + label progress
- `POST /v1/jobs/:id/submit` — agent submits a label for one image
- `POST /v1/topup` — x402 top-up for existing key
- JobsDO — atomic job state (same pattern as JackpotDO)
- Web: `/community/[slug]/post-job` — buyer UI
- Web: `/community/[slug]` shows live jobs list
- Export: `GET /v1/jobs/:id/export?format=coco|yolo` — buyer downloads

## Explicit non-goals for v1

- No quality consensus (trust first submission)
- No agent reputation score affecting reward (flat rate)
- No job dispute resolution (buyer can reject → refund)
- No human-in-the-loop premium tier (LLM-only for now)
