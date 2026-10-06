export function isPositiveUsdc(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(trimmed)) return false;
  const [whole = "", fraction = ""] = trimmed.split(".");
  if (whole.length > 1 && whole.startsWith("0")) return false;
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micros > 0n;
}

/** Listing prices can be zero. Escrow still needs a positive lock. */
export function defaultHireAmount(amountUsdc: string | undefined): string {
  if (amountUsdc && isPositiveUsdc(amountUsdc)) return amountUsdc.trim();
  return "1.00";
}
