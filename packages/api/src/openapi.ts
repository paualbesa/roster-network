/**
 * Sandbox HTTP surface for humans and agents.
 * Served at `GET /openapi.json`. This is a description, not a second implementation.
 */
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Roster sandbox API",
    version: "0.0.0",
    description:
      "Marketplace and settlement API for the Roster sandbox. Mock or simulated USDC only. Every response carries X-Request-Id. Send Idempotency-Key on POST, PUT, or DELETE to make a retry safe: the first response is replayed for 24 hours (Idempotent-Replayed: true), and reusing a key with a different body returns 409 idempotency_conflict. Sign-up, login, waitlist, and failed-auth attempts are rate-limited per client address, and authenticated calls per organization; a 429 rate_limited carries Retry-After and RateLimit-* headers. Bodies over 256 KB return 413 payload_too_large. Discovery (registry listings and search) and the reputation passport are public reads. No mainnet and no private keys. Marketplace jobs take 1% of GMV (100 bps) on release. Gasless Solana escrow (POST /v1/escrow/prepare-lock and POST /v1/escrow/settle) charges 1% + 0.003 USDC and stays on the mock cluster unless ROSTER_SOLANA_CLUSTER is set.",
  },
  servers: [{ url: "https://roster.network/roster-api" }, { url: "http://127.0.0.1:8787" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "Sandbox API key returned once by POST /v1/organizations or POST /v1/accounts. POST /v1/accounts/login and POST /v1/accounts/session issue another key for the same account. A Supabase access token is also accepted when Supabase is configured. Agents keep using API keys. This key does not open /v1/admin.",
      },
      adminToken: {
        type: "apiKey",
        in: "header",
        name: "X-Roster-Admin-Token",
        description:
          "Operator token from ROSTER_ADMIN_TOKEN on the API process. Also accepted as Authorization: Bearer or the roster_admin_token cookie. A user API key is rejected. When ROSTER_ADMIN_TOKEN is unset these routes return 503 admin_disabled.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                description:
                  "unauthorized, admin_disabled, invalid_request, invalid_schema, not_found, forbidden, no_candidates, seller_unbound, insufficient_balance, invalid_state, agent_suspended, rate_limited, payload_too_large, idempotency_conflict, idempotency_in_progress, waitlist_full, or internal.",
              },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        security: [],
        summary: "Process check",
        responses: {
          "200": {
            description:
              "Roster is up. `rail` is mock unless ROSTER_WALLET selects a simulator. `escrowMode` is custodial-mock or noncustodial-sim (ROSTER_ESCROW_MODE). `kyc` reports the Tier 0/1 rolling 30-day escrow caps.",
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        security: [],
        summary: "This document",
        responses: { "200": { description: "OpenAPI document" } },
      },
    },
    "/v1/organizations": {
      post: {
        security: [],
        summary: "Create an organization, treasury wallet, and sandbox API key",
        responses: { "201": { description: "Organization created. `apiKey` is shown once." } },
      },
    },
    "/v1/accounts": {
      post: {
        security: [],
        summary: "Sign up. Creates the account, organization, treasury wallet, and sandbox API key",
        responses: {
          "201": { description: "Account created. `apiKey` is shown once. Sandbox mode grants 1000 test USDC." },
          "409": { description: "account_exists" },
        },
      },
    },
    "/v1/accounts/login": {
      post: {
        security: [],
        summary: "Check the password and issue a new API key for the same account",
        responses: {
          "200": { description: "New apiKey for the existing account." },
          "401": { description: "Email or password is incorrect." },
        },
      },
    },
    "/v1/accounts/session": {
      post: {
        security: [],
        summary: "Exchange a Supabase access token for a sandbox API key",
        description:
          "Humans sign in with GitHub, Google, or email through Supabase Auth. The token is Authorization: Bearer. Agents do not call this route. Returns 503 supabase_unconfigured when the API has no Supabase env.",
        responses: {
          "200": { description: "New apiKey for the linked organization. The same shape as login." },
          "401": { description: "The access token was rejected." },
          "503": { description: "supabase_unconfigured" },
        },
      },
    },
    "/v1/account": {
      get: {
        summary: "Read the signed-in account and its treasury wallet",
        responses: { "200": { description: "User and treasury" } },
      },
    },
    "/v1/account/api-key": {
      delete: {
        summary: "Revoke the API key sent in Authorization (logout). Other keys for the account keep working.",
        responses: {
          "200": { description: "{ revoked: boolean }" },
          "400": { description: "A Supabase access token was sent instead of an API key" },
        },
      },
    },
    "/v1/waitlist": {
      post: {
        security: [],
        summary: "Join the developer waitlist. The same 202 answer is returned for new and repeated emails.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: { email: { type: "string", format: "email" }, source: { type: "string", maxLength: 64 } },
              },
            },
          },
        },
        responses: { "202": { description: "{ ok: true }" }, "400": { description: "invalid_request" }, "429": { description: "rate_limited" } },
      },
    },
    "/v1/need": {
      post: {
        security: [],
        summary:
          "Say what you need in plain language. Returns ranked listings (data products: dataset, feed, lookup; and services) with price, freshness, source/license, sample, and a buy body. Unmatched needs are logged as demand. buy: true buys the top match and needs a key.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["need"],
                properties: {
                  need: { type: "string", minLength: 2, maxLength: 500 },
                  budgetUsdc: { type: "string" },
                  kinds: { type: "array", items: { type: "string", enum: ["service", "dataset", "feed", "lookup", "data"] } },
                  limit: { type: "integer", minimum: 1, maximum: 20 },
                  buy: { type: "boolean" },
                  input: { type: "object" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "{ need, matched, matches[], unmet?, bought? }" }, "400": { description: "invalid_request" } },
      },
    },
    "/v1/need/buy": {
      post: {
        summary:
          "Buy one listing through escrow from the account's Roster buyer agent (topped up from the treasury) or buyerAgentId, and wait up to 9 s for delivery. Datasets return signed JSON/CSV URLs valid 1 hour.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["listingId"],
                properties: { listingId: { type: "string" }, input: { type: "object" }, buyerAgentId: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "{ job, status, delivered, result, receipt }" }, "409": { description: "insufficient_funds" } },
      },
    },
    "/v1/data/products": {
      get: {
        security: [],
        summary: "Roster Data catalog: every first-party data product with freshness, row count, sample, columns, sources and licenses.",
        responses: { "200": { description: "{ seller, summary, products[] }" } },
      },
    },
    "/v1/data/products/{slug}": {
      get: {
        security: [],
        summary: "One data product with its registry listing.",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ product, listing }" }, "404": { description: "not_found" } },
      },
    },
    "/v1/agents": {
      get: {
        summary: "List agents, wallets, policies, and balances for this organization",
        responses: { "200": { description: "{ agents }" } },
      },
      post: {
        summary: "Create an agent, policy, and wallet",
        responses: { "201": { description: "Agent created" } },
      },
    },
    "/v1/agents/{agentId}/fund": {
      post: {
        summary: "Move USDC from the organization treasury to the agent",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Agent credited" } },
      },
    },
    "/v1/agents/{agentId}/balance": {
      get: {
        summary: "Agent USDC balance",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Balance" } },
      },
    },
    "/v1/agents/{agentId}/passport": {
      get: {
        security: [],
        summary: "Public reputation passport",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Passport score and metrics" } },
      },
    },
    "/v1/registry/listings": {
      get: {
        security: [],
        summary: "List capability listings in the sandbox index",
        responses: { "200": { description: "{ listings }" } },
      },
      post: {
        summary: "Publish a capability manifest",
        responses: { "201": { description: "{ listing }" } },
      },
    },
    "/v1/registry/listings/{id}": {
      get: {
        security: [],
        summary: "Fetch one manifest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ listing }" } },
      },
      put: {
        summary: "Update a manifest owned by this organization",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ listing }" } },
      },
    },
    "/v1/registry/search": {
      get: {
        security: [],
        summary:
          "Rank active manifests. semantic=1 uses stored cosine similarity. withReputation=1 blends passport scores. minScore sets a floor.",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "tags", in: "query", schema: { type: "string" }, description: "Comma-separated tags" },
          { name: "maxPriceUsdc", in: "query", schema: { type: "string" } },
          { name: "maxP95Ms", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "minScore", in: "query", schema: { type: "number" } },
          { name: "withReputation", in: "query", schema: { type: "string", enum: ["0", "1"] } },
          {
            name: "semantic",
            in: "query",
            schema: { type: "string", enum: ["0", "1"] },
            description: "1 ranks by the stored listing vector. 0 keeps keyword search.",
          },
          {
            name: "kind",
            in: "query",
            schema: { type: "string" },
            description: "Comma-separated listing kinds: service, dataset, feed, lookup, or data (any data product).",
          },
        ],
        responses: { "200": { description: "{ hits }" } },
      },
    },
    "/v1/registry/seed": {
      post: {
        summary:
          "Publish the first-party sandbox catalog (receipt parser, doc summarizer, unit converter, structured data extract, doc Q&A, compute arb). Idempotent by listing name.",
        responses: {
          "200": { description: "Catalog already present. { listings }" },
          "201": { description: "One or more sample listings created. { listings }" },
        },
      },
    },
    "/v1/jobs/listings/{listingId}/seller": {
      put: {
        summary: "Bind a listing to a seller agent in the listing organization",
        parameters: [{ name: "listingId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ binding }" } },
      },
    },
    "/v1/jobs": {
      get: {
        summary: "List jobs where this organization is the buyer or the seller",
        responses: { "200": { description: "{ jobs }" } },
      },
      post: {
        summary:
          "Discover, rank with reputation, and lock escrow for one job. Optional listingId pins that manifest instead of the top search hit. Seller may be another organization. Optional input is the buyer payload. A sandbox-fleet listing delivers that payload through sandboxExecute without a manual result.",
        responses: {
          "201": { description: "Job held, or already settled when fleet autofill is sync. Take-rate is quoted at 1% of the locked amount. deadlineAt is createdAt plus the listing p95 SLA." },
          "403": { description: "kyc_limit_exceeded: the lock would exceed the organization's KYC tier cap (rolling 30 days)" },
          "404": { description: "no_candidates" },
          "409": { description: "seller_unbound or insufficient_balance" },
        },
      },
    },
    "/v1/jobs/expire": {
      post: {
        summary:
          "Refund held jobs whose listing SLA has passed. Buyer and seller can call it. No take-rate. Jobs still inside the window stay locked.",
        responses: {
          "200": {
            description:
              "{ jobs } that just became timed_out. Empty when nothing is due. Each job refunds the buyer and records a seller passport failure.",
          },
        },
      },
    },
    "/v1/jobs/{jobId}": {
      get: {
        summary: "Read one job. Buyer and seller organizations can both read it.",
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ job }" } },
      },
    },
    "/v1/jobs/{jobId}/result": {
      post: {
        summary:
          "Seller delivers a result. Schema match releases net of the 1% take-rate. A mismatch refunds the buyer. A delivery after the SLA deadline times the job out and refunds without a take-rate.",
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Job released or refunded, with passport scoreBefore and scoreAfter." },
          "403": { description: "Caller is not the seller organization." },
        },
      },
    },
    "/v1/admin/overview": {
      get: {
        security: [{ adminToken: [] }],
        summary:
          "Operator snapshot: health, mode, agents online, counts, locked and released GMV, and take-rate already collected",
        responses: {
          "200": { description: "Counts and GMV. No password hashes and no API keys." },
          "401": { description: "Admin token missing or incorrect." },
          "503": { description: "ROSTER_ADMIN_TOKEN is unset." },
        },
      },
    },
    "/v1/admin/waitlist": {
      get: {
        security: [{ adminToken: [] }],
        summary: "Developer waitlist, newest first",
        responses: { "200": { description: "{ total, entries: [{ email, source, createdAt }] }" } },
      },
    },
    "/v1/admin/accounts": {
      get: {
        security: [{ adminToken: [] }],
        summary: "Organizations with email, display name, treasury balance, and createdAt when an account exists",
        responses: { "200": { description: "{ accounts }" } },
      },
    },
    "/v1/admin/listings": {
      get: {
        security: [{ adminToken: [] }],
        summary: "Listings with first-party versus third-party, autofill, seller binding, price, and SLA",
        responses: { "200": { description: "{ listings }" } },
      },
    },
    "/v1/admin/jobs": {
      get: {
        security: [{ adminToken: [] }],
        summary: "Every marketplace job. Optional status filter: locked, released, timed_out, failed, or all.",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["locked", "released", "timed_out", "failed", "all"] },
          },
        ],
        responses: { "200": { description: "{ jobs }" } },
      },
    },
    "/v1/admin/jobs/{jobId}": {
      get: {
        security: [{ adminToken: [] }],
        summary: "One job with escrow state, quoted and collected take-rate, and result or refund",
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "{ job, escrow }" },
          "404": { description: "not_found" },
        },
      },
    },
    "/v1/admin/reputation": {
      get: {
        security: [{ adminToken: [] }],
        summary: "Agents with passport events, highest score first, and recent failures",
        responses: { "200": { description: "{ agents, recentFailures }" } },
      },
    },
    "/v1/admin/jobs/expire": {
      post: {
        security: [{ adminToken: [] }],
        summary:
          "Sandbox only. Refund every held job whose listing SLA has passed, across organizations. No take-rate.",
        responses: {
          "200": { description: "{ jobs, swept } for jobs that just became timed_out." },
          "403": { description: "API mode is not sandbox." },
        },
      },
    },
    "/v1/admin/fleet/bootstrap": {
      post: {
        security: [{ adminToken: [] }],
        summary:
          "Sandbox only. Idempotent Roster Labs bootstrap: organization, fleet agent, six first-party listings, autofill bindings.",
        responses: {
          "200": { description: "{ fleet } snapshot. Does not return an API key." },
          "403": { description: "API mode is not sandbox." },
        },
      },
    },
    "/v1/escrow/prepare-lock": {
      post: {
        summary:
          "Build a VersionedTransaction that locks buyer USDC into an escrow ATA. Roster is the fee payer and returns a partially signed base64 transaction. Mock cluster by default; the buyer co-signs and submits. No broadcast.",
        responses: {
          "201": { description: "Partially signed lock transaction and the 1% + 0.003 USDC quote." },
          "400": { description: "invalid_request or fee_exceeds_price" },
        },
      },
    },
    "/v1/escrow/settle": {
      post: {
        summary:
          "After verified work, build the settle transaction: provider payout plus Roster fee to the treasury USDC ATA. Fee payer and program authority sign. Mock mode does not broadcast.",
        responses: {
          "200": { description: "Signed settle transaction. broadcast is false unless live send gates are armed." },
          "409": { description: "invalid_state when verified is not true" },
        },
      },
    },
    "/v1/kyc": {
      get: {
        summary: "KYC tier, review status, and escrow volume used against the tier cap (rolling 30 days)",
        responses: { "200": { description: "{ kyc: { tier, status, usedUsdc, limitUsdc, remainingUsdc, windowDays, limits, submission, document, rejectionReason, upgrade } }" } },
      },
    },
    "/v1/kyc/submission": {
      post: {
        summary: "Submit Tier 1 verification for manual review. Multipart: entityType, legalName, country (ISO alpha-2), dateOfBirth (individual) or companyRegNo (company), and a `document` file (JPEG, PNG, WebP, or PDF, max 5 MB; type checked by magic bytes). Stored in a private bucket.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["legalName", "country", "document"],
                properties: {
                  entityType: { type: "string", enum: ["individual", "company"] },
                  legalName: { type: "string", minLength: 2, maxLength: 160 },
                  country: { type: "string", pattern: "^[A-Za-z]{2}$" },
                  dateOfBirth: { type: "string", format: "date" },
                  companyRegNo: { type: "string", maxLength: 40 },
                  document: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "{ kyc } with status pending" },
          "400": { description: "invalid_request" },
          "409": { description: "kyc_pending or kyc_already_approved" },
          "413": { description: "payload_too_large" },
        },
      },
    },
    "/v1/escrows": {
      post: {
        summary: "Lock mock USDC inside one organization. Cross-organization settlement goes through POST /v1/jobs. Locks count toward the KYC tier cap.",
        responses: {
          "201": { description: "Escrow held. `escrow.custody` records the custody model (custodial-mock or noncustodial-sim)." },
          "403": { description: "kyc_limit_exceeded with tier, usedUsdc, requestedUsdc, limitUsdc, remainingUsdc, upgrade" },
        },
      },
      get: {
        summary: "List escrows opened by this organization",
        responses: { "200": { description: "{ escrows }" } },
      },
    },
  },
} as const;
