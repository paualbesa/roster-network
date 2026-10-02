const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Encode bytes as Bitcoin base58. Leading zero bytes become leading "1"s. */
export function encodeBase58(bytes: Uint8Array): string {
  let zeroCount = 0;
  while (zeroCount < bytes.length && bytes[zeroCount] === 0) zeroCount += 1;
  if (zeroCount === bytes.length) return "1".repeat(bytes.length);

  let value = 0n;
  for (let index = zeroCount; index < bytes.length; index += 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = (ALPHABET[remainder] ?? "") + encoded;
  }
  return "1".repeat(zeroCount) + encoded;
}

/** Decode Bitcoin base58. Returns null when the text is empty or has a bad character. */
export function decodeBase58(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let zeroCount = 0;
  while (zeroCount < trimmed.length && trimmed[zeroCount] === "1") zeroCount += 1;

  let value = 0n;
  for (let index = zeroCount; index < trimmed.length; index += 1) {
    const alphabetIndex = ALPHABET.indexOf(trimmed[index] ?? "");
    if (alphabetIndex < 0) return null;
    value = value * 58n + BigInt(alphabetIndex);
  }

  const body: number[] = [];
  while (value > 0n) {
    body.push(Number(value & 0xffn));
    value >>= 8n;
  }
  body.reverse();

  const out = new Uint8Array(zeroCount + body.length);
  out.set(body, zeroCount);
  return out;
}
