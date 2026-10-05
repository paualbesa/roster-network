/** Public origin for canonical links, the sitemap, and Open Graph images. */
export const SITE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL) ?? "https://roster.network";

export function normalizeSiteUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const GITHUB_URL = "https://github.com/paualbesa/albesa-agent-sdk";
export const GITHUB_README_URL = `${GITHUB_URL}/blob/main/README.md`;

export const SANDBOX_DISCLAIMER =
  "Roster v0 is a sandbox. Mock USDC only. No mainnet settlement, no private keys, and no real payments on this site.";
