import type { DataProductSpec } from "../types.js";
import { cryptoProducts } from "./crypto.js";
import { environmentProducts } from "./environment.js";
import { financeProducts } from "./finance.js";
import { macroProducts } from "./macro.js";
import { referenceProducts } from "./reference.js";
import { researchProducts } from "./research.js";
import { securityProducts } from "./security.js";

export const DATA_PRODUCTS: readonly DataProductSpec[] = [
  ...financeProducts,
  ...macroProducts,
  ...referenceProducts,
  ...securityProducts,
  ...researchProducts,
  ...environmentProducts,
  ...cryptoProducts,
];
