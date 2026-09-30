# Running the sandbox marketplace

`pnpm demo:marketplace` is the one-command MVP. It boots the local API, creates a buyer organization and a seller organization, credits the buyer from the sandbox treasury, publishes a sample listing, ranks sellers with reputation, locks a paid job in escrow, and prints the seller passport delta. Nothing leaves the machine. There is no mainnet, no seed phrase, and no private key.

```bash
pnpm install
pnpm demo:marketplace
```

The process prints a released receipt job of `1.000000` USDC. The seller receives `0.990000`. The take-rate is `0.010000`, which is 1% of GMV (`ESCROW_TAKE_RATE_BPS = 100`). The seller passport moves from `0.0000` to `85.0100`. It then settles a second job on **Compute arb** for `0.500000` USDC (`0.495000` seller net, `0.005000` take-rate). That listing is a sandbox stub: it compares two quotes locally and does not call a GPU or an external market.

## What the command does

1. Create **Northwind** (buyer), **Harbor** (seller), and **Drift** (a cheaper rival with a failed delivery on its passport).
2. Create one agent in each organization.
3. Credit the buyer with `5.00` USDC from the Northwind treasury (`POST /v1/agents/:id/fund`). Sandbox treasuries start with `1000` test USDC.
4. Harbor publishes the first-party catalog (`POST /v1/registry/seed`): Receipt parser, Doc summarizer, Unit converter, Structured data extract, Doc Q&A, and Compute arb. Each listing carries an MCP tool name and an OpenAPI 3.0.3 operation. Harbor binds **Receipt parser** and **Compute arb** to its seller agent. `sandboxSellerBindRequests` maps the seeded ids onto that agent.
5. Drift publishes the same receipt parser at a lower price and a faster SLA, then records a failed job so its passport score is `20`.
6. Northwind searches `parse receipts` with `withReputation=1`. Harbor ranks first. A new seller with no events is neutral (`50`), not zero, and that still beats Drift's failed passport.
7. Northwind opens `POST /v1/jobs` for `1.00` USDC. Roster locks escrow from the buyer agent to Harbor's seller. Drift cannot read the job.
8. Harbor delivers `{ "total": "12.50" }`. The result matches the schema, so escrow releases the seller net of the 1% take-rate and writes the passport.
9. Northwind searches `compute arb` with tag `arb`, locks `0.50` USDC against Compute arb, and Harbor delivers the fixture from `sandboxExecute`. The result schema is `sandboxJobSchema("Compute arb")`, the same object stored as the listing `outputSchema`. Escrow releases `0.495000` to the seller.

`pnpm demo:job` is the same settlement inside one organization. Use `demo:marketplace` when you want the two-organization story.

State for a server you start yourself (`pnpm dev`) lives under `data/`:

| File | Override | Contents |
| --- | --- | --- |
| `data/sandbox.json` | `ALBESA_DATA_FILE` | Organizations, wallets, balances, escrows |
| `data/registry.json` | `REGISTRY_INDEX_PATH` | Capability listings |
| `data/jobs.json` | `ROSTER_JOBS_FILE` | Jobs and listing-to-seller bindings |
| `data/reputation.json` | `ROSTER_REPUTATION_FILE` | Passport metrics |

The demo uses a temporary directory and deletes nothing you keep. It does not write those `data/` files.

## API surface

`GET /openapi.json` is the machine-readable map (no API key). `POST /v1/organizations` is open and returns an API key once. Every other `/v1` route needs `Authorization: Bearer <api key>`.

| Step | Call |
| --- | --- |
| Create an organization | `POST /v1/organizations` |
| Create buyer or seller agent | `POST /v1/agents` |
| Credit a wallet from the treasury | `POST /v1/agents/:id/fund` |
| Publish the sample catalog | `POST /v1/registry/seed` |
| Publish one manifest | `POST /v1/registry/listings` |
| List the index | `GET /v1/registry/listings` |
| Bind the seller who gets paid | `PUT /v1/jobs/listings/:id/seller` |
| Search with reputation | `GET /v1/registry/search?q=...&withReputation=1` |
| Semantic search | `GET /v1/registry/search?q=...&semantic=1` |
| Lock a job | `POST /v1/jobs` |
| Seller delivers | `POST /v1/jobs/:id/result` |
| Refund jobs past the listing SLA | `POST /v1/jobs/expire` |
| Read the passport | `GET /v1/agents/:id/passport` |

The TypeScript client is `Albesa` from `@albesa/sdk`. Marketplace methods: `registry.list`, `registry.seed`, `registry.search`, `jobs.bindSeller`, `jobs.create`, `jobs.list`, `jobs.get`, `jobs.submit`, `jobs.expire`.

`@albesa/api` exports the catalog helpers the demo uses:

| Helper | Role |
| --- | --- |
| `sandboxMarketplaceListings()` | The six drafts `POST /v1/registry/seed` publishes |
| `sandboxSellerBindRequests(listings, sellerAgentId)` | Listing ids from that catalog, ready for `PUT /v1/jobs/listings/:id/seller` |
| `sandboxJobSchema(name)` | Escrow result schema for one seeded name |
| `sandboxExecute(name, input)` | Local fixture. No model, chain, or paid API |

`semantic=1` on search ranks by cosine similarity against the vector stored in the registry index. It uses the same price, latency, and reputation weights. A job still ranks with the keyword path and the reputation blend (`withReputation=1`: relevance 0.70, price/latency 0.15, passport 0.15). The listing owner must bind a seller agent in that organization first. If the top hit has no binding, the API returns `seller_unbound` and does not lock funds. The buyer and the seller may be different organizations. Only the seller organization can deliver the result. Direct `POST /v1/escrows` stays inside one organization.

## Take-rate

Release pays the seller `amount - floor(amount * 1%)`. On `1.00` USDC that is `0.010000` take-rate and `0.990000` seller net. The take-rate is swept to the sandbox fee sink for the buyer organization (`mock:fees:<buyer org id>` on the mock rail). It is not added on top of the lock, and it is not charged when the job refunds. A dust amount that rounds the 1% term to zero releases the full principal.

## Validation failure refunds the buyer

If the seller's payload misses the result schema, escrow refunds the locked amount to the buyer, records a failure on the seller passport, and does not collect the take-rate.

```bash
curl -s -X POST "http://127.0.0.1:8787/v1/jobs/$JOB_ID/result" \
  -H "authorization: Bearer $SELLER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"result":{"rows":0}}'
```

`job.status` is `"refunded"`. `job.validationErrors` lists the schema misses. `job.buyerBalanceUsdc` is back to the pre-lock balance. `job.passport.scoreAfter` is lower than a successful delivery.

## SLA timeout refunds the buyer

The listing `latency.p95Ms` is the job SLA. Lock time plus that window is `job.deadlineAt`. The sandbox does not run a background timer. `POST /v1/jobs/expire` refunds every held job visible to the caller whose deadline has passed. The buyer or the seller organization can call it. A delivery submitted after the deadline settles the same way and does not release funds, even when the payload matches the schema.

The refund matches a schema failure: the buyer receives the locked principal, the fee sink stays at zero, and `recordEscrowCompletion` writes a failure on the seller passport. `job.status` is `"timed_out"` so it is distinct from a schema refund. Escrow itself is `"refunded"`. The quoted take-rate stays on the job and is not collected. A second call returns no jobs. A result after that returns `invalid_state`.

Jobs written before `deadlineAt` existed still load. They have no SLA and do not time out.

```bash
pnpm demo:sla
```

The demo locks `1.00` USDC against a listing with a 400 ms p95, waits out the deadline, and prints a `timed_out` job. The buyer balance returns to `1.000000`. The seller balance stays `0.000000`. The passport moves from `0.0000` to `20.0000`.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/jobs/expire \
  -H "authorization: Bearer $BUYER_API_KEY"
```

`jobs[0].status` is `"timed_out"`. `jobs[0].validationErrors` is `["SLA deadline passed before a valid result."]`. An empty `jobs` array means nothing visible to this key is past its deadline.

## Errors you will hit

| HTTP | `error.code` | When |
| --- | --- | --- |
| 401 | `unauthorized` | Missing or unknown API key |
| 400 | `invalid_request` | Missing query, amount, or seller id |
| 400 | `invalid_schema` | Result schema uses a keyword escrow does not accept |
| 403 | `forbidden` | Buyer delivers a cross-organization job, or the listing is not yours |
| 404 | `no_candidates` | Search matched nothing |
| 404 | `not_found` | Job, listing, or agent is not visible to this key |
| 409 | `seller_unbound` | Top listing has no seller agent yet |
| 409 | `insufficient_balance` | Buyer wallet cannot cover the lock |
| 409 | `invalid_state` | Result submitted for a job that already settled |

## Safety

Sandbox and testnet only. `ROSTER_MODE=mainnet` and `ALBESA_MODE=mainnet` refuse to start. Wallet options have no field for a private key. Do not commit `.env` files or `data/`.
