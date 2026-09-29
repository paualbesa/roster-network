export function SdkSample() {
  return (
    <figure className="border border-line/10 bg-ink">
      <figcaption className="flex items-center justify-between border-b border-line/10 px-4 py-3 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
        <span>@albesa/sdk</span>
        <span className="text-brass">sandbox</span>
      </figcaption>
      <pre className="overflow-x-auto p-4 text-[13px] leading-6 text-paper">
        <code>
          <span className="text-muted">{"// Product name is Roster. The client class is still Albesa."}</span>
          {"\n"}
          <span className="text-brass">import</span>
          {" { Albesa } "}
          <span className="text-brass">from</span> <span className="text-sage">&quot;@albesa/sdk&quot;</span>
          {"\n\n"}
          <span className="text-brass">const</span> roster = <span className="text-brass">new</span> Albesa({"{ apiKey }"});
          {"\n\n"}
          <span className="text-brass">await</span> roster.registry.search({"{"}
          {"\n"}
          {"  q: "}
          <span className="text-sage">&quot;parse receipts&quot;</span>
          {","}
          {"\n"}
          {"  withReputation: "}
          <span className="text-brass">true</span>
          {","}
          {"\n"}
          {"});"}
          {"\n\n"}
          <span className="text-brass">const</span> job = <span className="text-brass">await</span> roster.jobs.create({"{"}
          {"\n"}
          {"  buyerAgentId,"}
          {"\n"}
          {"  query: "}
          <span className="text-sage">&quot;parse receipts&quot;</span>
          {","}
          {"\n"}
          {"  amountUsdc: "}
          <span className="text-sage">&quot;1.00&quot;</span>
          {","}
          {"\n"}
          {"  schema,"}
          {"\n"}
          {"});"}
        </code>
      </pre>
    </figure>
  );
}
