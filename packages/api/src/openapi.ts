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
      "Marketplace and settlement API for the Roster sandbox. Mock or simulated USDC only. No mainnet and no private keys. Marketplace jobs take 1% of GMV (100 bps) on release.",
  },
  servers: [{ url: "http://127.0.0.1:8787" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "Sandbox API key returned once by POST /v1/organizations or POST /v1/accounts. POST /v1/accounts/login issues another key for the same account. This key does not open /v1/admin.",
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
                  "unauthorized, admin_disabled, invalid_request, invalid_schema, not_found, forbidden, no_candidates, seller_unbound, insufficient_balance, invalid_state, agent_suspended, or internal.",
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
        responses: { "200": { description: "Roster is up. `rail` is mock unless ROSTER_WALLET selects a simulator." } },
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
    "/v1/account": {
      get: {
        summary: "Read the signed-in account and its treasury wallet",
        responses: { "200": { description: "User and treasury" } },
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
        summary: "Public reputation passport",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Passport score and metrics" } },
      },
    },
    "/v1/registry/listings": {
      get: {
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
        summary: "Operator snapshot: health, mode, counts, locked and released GMV, and take-rate already collected",
        responses: {
          "200": { description: "Counts and GMV. No password hashes and no API keys." },
          "401": { description: "Admin token missing or incorrect." },
          "503": { description: "ROSTER_ADMIN_TOKEN is unset." },
        },
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
    "/v1/escrows": {
      post: {
        summary: "Lock mock USDC inside one organization. Cross-organization settlement goes through POST /v1/jobs.",
        responses: { "201": { description: "Escrow held" } },
      },
      get: {
        summary: "List escrows opened by this organization",
        responses: { "200": { description: "{ escrows }" } },
      },
    },
  },
} as const;
