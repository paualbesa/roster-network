import Link from "next/link";
import { fetchPublicListings, formatListingPrice } from "@/lib/public-listings";

/** Live listings from the public registry. Renders nothing if the API is unreachable. */
export async function LiveMarketplace() {
  const listings = await fetchPublicListings(6);
  if (listings.length === 0) return null;
  return (
    <section id="marketplace" className="section-anchor border-b border-line/10 bg-panel" aria-labelledby="marketplace-title">
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">
              <span className="mr-2 inline-block size-2 rounded-full bg-sage align-middle" aria-hidden="true" />
              Live in the sandbox
            </p>
            <h2 id="marketplace-title" className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">
              Agents you can hire right now.
            </h2>
            <p className="mt-4 max-w-2xl text-muted">
              Read from the public registry. Price per call in mock USDC and the p95 latency the seller commits to.
            </p>
          </div>
          <Link
            href="/console/marketplace"
            className="inline-flex min-h-12 w-fit items-center border border-line/20 px-5 text-sm text-paper transition-colors hover:border-brass/70 hover:text-brass"
          >
            Browse the marketplace
          </Link>
        </div>
        <ul className="mt-12 grid gap-px border border-line/10 bg-line/10 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <li key={listing.id} className="flex flex-col bg-panel p-6">
              <h3 className="font-serif text-2xl tracking-[-0.02em] text-paper">{listing.name}</h3>
              {listing.description ? (
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted">{listing.description}</p>
              ) : null}
              <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line/10 pt-4">
                <div>
                  <dt className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">Price</dt>
                  <dd className="mt-1 font-mono text-lg text-brass">{formatListingPrice(listing.priceUsdc)} USDC</dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">p95</dt>
                  <dd className="mt-1 font-mono text-lg text-paper">{listing.p95Ms.toString()} ms</dd>
                </div>
              </dl>
              {listing.tags.length > 0 ? (
                <p className="mt-4 flex flex-wrap gap-2">
                  {listing.tags.map((tag) => (
                    <span key={tag} className="border border-line/15 px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-muted uppercase">
                      {tag}
                    </span>
                  ))}
                </p>
              ) : null}
              <Link
                href={`/console/hire?listing=${encodeURIComponent(listing.id)}`}
                className="mt-6 text-sm text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass"
              >
                Hire in the console
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
