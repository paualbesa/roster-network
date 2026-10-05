import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ListingBuy } from "@/components/listing-buy";
import { formatAge, formatUsdc, kindHint, kindLabel, sampleCell, sampleColumns } from "@/lib/need";
import { fetchListingDetail } from "@/lib/public-data";

export const revalidate = 60;

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const listing = await fetchListingDetail(id);
  if (!listing) return { title: "Listing not found" };
  return {
    title: listing.name,
    description: listing.description.slice(0, 160),
    alternates: { canonical: `/listings/${encodeURIComponent(listing.id)}` },
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024).toString()} KB`;
  return `${bytes.toString()} B`;
}

function whatYouGet(kind: string, formats: string[]): string {
  if (kind === "dataset") return `The full, cleaned table as signed ${formats.map((format) => format.toUpperCase()).join(" + ")} download links (valid 1 hour), plus row count, SHA-256, a preview, and attribution.`;
  if (kind === "feed") return "The latest items as JSON. Filter with since, q, or limit. Includes attribution.";
  if (kind === "lookup") return "A direct answer to your input as JSON matches, with source attribution.";
  return "A result validated against the listing's output schema before escrow releases.";
}

export default async function ListingPage({ params }: { params: Params }) {
  const { id } = await params;
  const listing = await fetchListingDetail(id);
  if (!listing) notFound();
  const product = listing.dataProduct;
  const sample = product?.sample ?? [];
  const columns = sampleColumns(sample, 8);
  return (
    <main id="content" className="mx-auto max-w-6xl px-6 py-12 lg:py-16">
      <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">
        <Link href="/data" className="hover:text-brass-bright">Roster {product ? "Data" : "Marketplace"}</Link> · {kindLabel(listing.kind)}
      </p>
      <h1 className="mt-4 max-w-4xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-balance md:text-5xl">{listing.name}</h1>
      <p className="mt-4 max-w-3xl text-base leading-7 text-muted text-pretty">{listing.description}</p>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-8">
          <section className="border border-line/10 bg-panel p-5">
            <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">What you get</h2>
            <p className="mt-2 text-sm leading-6 text-paper">{whatYouGet(listing.kind, product?.formats ?? [])}</p>
            <p className="mt-2 font-mono text-[11px] text-muted">{kindHint(listing.kind)}</p>
            <dl className="mt-5 grid gap-px bg-line/10 sm:grid-cols-4">
              <Fact label="Price" value={`${formatUsdc(listing.priceUsdc)} USDC`} />
              <Fact label="Freshness" value={product ? (product.live ? "Live" : `Updated ${formatAge(product.lastRefreshedAt)}`) : "On demand"} />
              <Fact label="Refresh" value={product?.refreshCadence || "—"} />
              <Fact label={product?.live ? "p95" : "Rows"} value={product && !product.live ? `${product.rowCount.toLocaleString("en-US")}${product.bytes ? ` · ${formatBytes(product.bytes)}` : ""}` : `${listing.p95Ms.toString()} ms`} />
            </dl>
          </section>

          {product && product.sources.length > 0 ? (
            <section className="border border-line/10 bg-panel p-5">
              <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Source &amp; license</h2>
              <ul className="mt-3 space-y-3">
                {product.sources.map((source) => (
                  <li key={source.url} className="text-sm leading-6">
                    <a href={source.url} rel="noreferrer" target="_blank" className="text-paper underline decoration-line/30 underline-offset-4 hover:text-brass">{source.name}</a>
                    <span className="text-muted"> · </span>
                    {source.licenseUrl ? (
                      <a href={source.licenseUrl} rel="noreferrer" target="_blank" className="text-sage underline decoration-sage/40 underline-offset-4">{source.license}</a>
                    ) : (
                      <span className="text-sage">{source.license}</span>
                    )}
                    {source.attribution ? <p className="text-xs text-muted">{source.attribution}</p> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-5 text-muted">Roster collects this from the official source, deduplicates and cleans it, and keeps it fresh so your agent does not have to.</p>
            </section>
          ) : null}

          {columns.length > 0 ? (
            <section>
              <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Sample</h2>
              <div className="mt-3 overflow-x-auto border border-line/10 bg-panel">
                <table className="w-full text-left font-mono text-xs">
                  <thead className="bg-panel-2 text-muted">
                    <tr>{columns.map((column) => <th key={column} scope="col" className="px-3 py-2 font-medium">{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {sample.slice(0, 5).map((row, index) => (
                      <tr key={index} className="border-t border-line/10">
                        {columns.map((column) => <td key={column} className="px-3 py-2 whitespace-nowrap text-paper">{sampleCell(row[column])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {product && product.columns.length > 0 ? (
            <section>
              <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Schema</h2>
              <div className="mt-3 overflow-x-auto border border-line/10 bg-panel">
                <table className="w-full text-left text-sm">
                  <tbody>
                    {product.columns.map((column) => (
                      <tr key={column.name} className="border-t border-line/10 first:border-t-0">
                        <td className="px-3 py-2 font-mono text-xs text-paper">{column.name}</td>
                        <td className="px-3 py-2 font-mono text-xs text-brass">{column.type}</td>
                        <td className="px-3 py-2 text-xs text-muted">{column.description ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Buy from code</h2>
            <pre className="mt-3 overflow-x-auto border border-line/10 bg-panel p-4 font-mono text-xs leading-5 text-paper">{`curl -X POST https://roster.network/roster-api/v1/need/buy \\
  -H "Authorization: Bearer $ROSTER_API_KEY" -H "content-type: application/json" \\
  -d '${JSON.stringify({ listingId: listing.id, input: product?.example ?? {} })}'

// SDK
const { matches } = await roster.need("${listing.name.replace(/"/g, "'").slice(0, 60)}");
const bought = await roster.buy({ listingId: "${listing.id}" });`}</pre>
          </section>
        </div>
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <ListingBuy listingId={listing.id} priceUsdc={listing.priceUsdc} example={product?.example ?? null} />
        </aside>
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-paper">{value}</dd>
    </div>
  );
}
