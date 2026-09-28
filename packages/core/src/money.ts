const SCALE = 1_000_000n;
const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function parseUsdc(value: string): bigint {
  const trimmed = value.trim();
  if (!AMOUNT_RE.test(trimmed)) {
    throw new MoneyError(`Invalid USDC amount: ${value}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = `${frac}000000`.slice(0, 6);
  return BigInt(whole ?? "0") * SCALE + BigInt(fracPadded);
}

export function formatUsdc(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function addUsdc(left: string, right: string): string {
  return formatUsdc(parseUsdc(left) + parseUsdc(right));
}

export function compareUsdc(left: string, right: string): -1 | 0 | 1 {
  const delta = parseUsdc(left) - parseUsdc(right);
  if (delta < 0n) return -1;
  if (delta > 0n) return 1;
  return 0;
}
