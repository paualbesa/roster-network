import type { Metadata } from "next";
import Link from "next/link";
import { NeedSearch } from "@/components/need-search";
import { formatAge, formatUsdc, kindLabel, type DataProductView, type ListingKind } from "@/lib/need";
import { fetchDataProducts } from "@/lib/public-data";

export const metadata: Metadata = {
  title: "Roster Data",
  description: "Cleaned, licensed public data your agent can buy per query: FX, macro, security advisories, research feeds, reference tables, weather.",
  alternates: { canonical: "/data" },
};

export const revalidate = 120;

const ORDER: ListingKind[] = ["dataset", "feed", "lookup"];

export default async function DataPage() {
  const products = await fetchDataProducts();
  const rows = products.reduce((sum, product) => sum + (product.derivedFrom ? 0 : product.rowCount), 0);
  return (
    <main id="content">
      <section className="border-b border-line/10">
        <div className="mx-auto max-w-6xl px-6 py-14 lg:py-20">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Roster Data</p>
          <h1 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">
            Data your agent would otherwise spend hours collecting.
          </h1>
          <p className="mt-4 max-w-2xl text-muted">
            {products.length.toString()} products · {rows.toLocaleString("en-US")} rows kept fresh from official open sources with their licenses recorded. Pay per query in USDC, only when the data is delivered.
          </p>
          <div className="mt-10">
            <NeedSearch variant="console" />
          </div>
        </div>
      </section>
      <div className="mx-auto max-w-6xl space-y-14 px-6 py-14">
        {ORDER.map((kind) => {
          const group = products.filter((product) => product.kind === kind);
          if (group.length === 0) return null;
          return (
            <section key={kind}>
              <h2 className="font-serif text-3xl tracking-[-0.03em]">{kindLabel(kind)}s</h2>
              <ul className="mt-6 grid gap-px border border-line/10 bg-line/10 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((product) => <ProductCard key={product.slug} product={product} />)}
              </ul>
            </section>
          );
        })}
        {products.length === 0 ? <p className="text-muted">The data catalog is loading. Try again in a minute.</p> : null}
      </div>
    </main>
  );
}

function ProductCard({ product }: { product: DataProductView }) {
  const href = product.listingId ? `/listings/${encodeURIComponent(product.listingId)}` : "/data";
  const source = product.sources[0];
  return (
    <li className="flex flex-col bg-panel p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] tracking-[0.12em] text-sage uppercase">
          {product.live ? "Live" : product.status === "ok" ? `Updated ${formatAge(product.lastRefreshedAt)}` : product.status}
        </span>
        <span className="font-mono text-sm text-brass">{formatUsdc(product.priceUsdc)} USDC</span>
      </div>
      <h3 className="mt-3 font-serif text-xl leading-tight tracking-[-0.02em] text-paper">
        <Link href={href} className="hover:text-brass">{product.name}</Link>
      </h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted">{product.description}</p>
      <p className="mt-auto pt-4 font-mono text-[11px] text-muted">
        {product.live ? "Live lookup" : product.derivedFrom ? `Answers from ${product.rowCount.toLocaleString("en-US")} rows` : `${product.rowCount.toLocaleString("en-US")} rows`} · {product.refreshCadence}
        {source ? ` · ${source.license}` : ""}
      </p>
    </li>
  );
}
