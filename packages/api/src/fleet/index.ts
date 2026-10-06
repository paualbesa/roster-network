import type { SandboxCapabilityDraft } from "../catalog.js";
import { codeTools } from "./code-tools.js";
import { dataTools } from "./data-tools.js";
import { extractionTools } from "./extraction-tools.js";
import { financeTools } from "./finance-tools.js";
import type { FleetTool, Json } from "./kit.js";
import { isRecord } from "./kit.js";
import { mediaTools } from "./media-tools.js";
import { researchTools } from "./research-tools.js";
import { seoTools } from "./seo-tools.js";
import { textTools } from "./text-tools.js";
import { translationTools } from "./translation-tools.js";

export type { FleetCategory, FleetTool } from "./kit.js";

/** Appended to every fleet description so buyers can tell first-party supply from third-party sellers. */
export const FLEET_OWNERSHIP_NOTE =
  "Operated by Roster Fleet, Roster's first-party seller agent. Deterministic sandbox implementation: no external model or paid API.";

const TOOLS: readonly FleetTool[] = [
  ...textTools,
  ...extractionTools,
  ...translationTools,
  ...dataTools,
  ...financeTools,
  ...codeTools,
  ...seoTools,
  ...researchTools,
  ...mediaTools,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function fleetTools(): readonly FleetTool[] {
  return TOOLS;
}

export function findFleetTool(name: string): FleetTool | undefined {
  return BY_NAME.get(name);
}

/** Registry draft for one fleet tool. `inputSchema.examples[0]` is a ready-to-send buyer input. */
export function fleetDraft(tool: FleetTool): SandboxCapabilityDraft {
  const inputSchema: Json = {
    type: "object",
    additionalProperties: false,
    required: tool.required,
    properties: tool.input,
    examples: [tool.example],
  };
  const description = `${tool.description} ${FLEET_OWNERSHIP_NOTE}`;
  const tags = [...new Set([...tool.tags, tool.category, "roster-fleet"])].slice(0, 16);
  const operationId = tool.slug.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
  return {
    name: tool.name,
    description,
    version: "1.0.0",
    inputSchema,
    outputSchema: tool.output,
    pricing: { model: "per_call", amountUsdc: tool.priceUsdc },
    latency: { p95Ms: tool.p95Ms, p50Ms: tool.p50Ms },
    tags,
    manifest: {
      mcp: { name: tool.slug, description, inputSchema },
      openapi: {
        openapi: "3.0.3",
        operationId,
        method: "post",
        path: `/fleet/${tool.slug.replace(/_/g, "-")}`,
        requestSchema: inputSchema,
        responseSchema: tool.output,
      },
    },
  };
}

/** Run a fleet tool. Bad input never throws: executors return a schema-valid result. */
export function runFleetTool(tool: FleetTool, input: unknown): Record<string, unknown> {
  const payload = isRecord(input) ? input : {};
  try {
    return tool.run(payload);
  } catch {
    return tool.run({});
  }
}
