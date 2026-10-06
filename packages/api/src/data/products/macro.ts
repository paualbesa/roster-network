import { SOURCES } from "../sources.js";
import type { DataColumn, DataFetchContext, DataProductSpec, Row } from "../types.js";
import { dedupe, fold, jsonStatRows, numberOrNull, parseCsv, round, str } from "../util.js";

const DAY = 86_400;
const EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

type JsonStat = Parameters<typeof jsonStatRows>[0];

async function eurostat(ctx: DataFetchContext, dataset: string, query: string): Promise<Record<string, string | number>[]> {
  const data = await ctx.fetchJson<JsonStat>(`${EUROSTAT}/${dataset}?format=JSON&lang=EN&${query}`, { timeoutMs: 120_000 });
  return jsonStatRows(data);
}

function eurostatSeries(options: {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  dataset: string;
  query: string;
  period: "month" | "quarter";
  valueColumns: { column: string; filter: Record<string, string>; description: string }[];
}): DataProductSpec {
  const columns: DataColumn[] = [
    { name: "geo", type: "string", description: "Eurostat geo code (ISO 3166 alpha-2, EU27_2020, EA20…)." },
    { name: "geo_name", type: "string", description: "Country or aggregate name." },
    { name: options.period, type: "string", description: options.period === "month" ? "Period, YYYY-MM." : "Period, YYYY-Qn." },
    ...options.valueColumns.map((value) => ({ name: value.column, type: "number" as const, description: value.description })),
  ];
  return {
    slug: options.slug,
    name: options.name,
    kind: "dataset",
    description: options.description,
    tags: [...options.tags, "eurostat", "eu", "macro", "statistics", "time-series"],
    sources: [SOURCES.eurostat],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.02",
    p95Ms: 6000,
    columns,
    ingest: async (ctx) => {
      const records = await eurostat(ctx, options.dataset, options.query);
      const byKey = new Map<string, Row>();
      for (const record of records) {
        const value = options.valueColumns.find((candidate) =>
          Object.entries(candidate.filter).every(([dim, code]) => record[dim] === code),
        );
        if (!value) continue;
        const period = String(record.time).replace("-Q", "-Q");
        const key = `${String(record.geo)}|${period}`;
        const row = byKey.get(key) ?? {
          geo: String(record.geo),
          geo_name: String(record.geo_label ?? record.geo),
          [options.period]: period,
        };
        row[value.column] = typeof record.value === "number" ? record.value : null;
        byKey.set(key, row);
      }
      return [...byKey.values()]
        .map((row) => {
          for (const value of options.valueColumns) row[value.column] = row[value.column] ?? null;
          return row;
        })
        .sort(
          (left, right) =>
            String(left.geo).localeCompare(String(right.geo)) ||
            String(left[options.period]).localeCompare(String(right[options.period])),
        );
    },
  };
}

interface IneSeries {
  Data: { Fecha: number; Anyo: number; FK_Periodo: number; Valor: number | null }[];
}

async function ineSeries(ctx: DataFetchContext, code: string, last: number): Promise<IneSeries["Data"]> {
  const data = await ctx.fetchJson<IneSeries>(`https://servicios.ine.es/wstempus/js/ES/DATOS_SERIE/${code}?nult=${last.toString()}`);
  return Array.isArray(data.Data) ? data.Data : [];
}

interface WorldBankRow {
  countryiso3code: string;
  country: { id: string; value: string };
  date: string;
  value: number | null;
}

async function worldBankAggregates(ctx: DataFetchContext): Promise<Set<string>> {
  const [, countries] = await ctx.fetchJson<[unknown, { id: string; iso2Code: string; region: { value: string } }[]]>(
    "https://api.worldbank.org/v2/country?format=json&per_page=400",
  );
  return new Set(countries.filter((country) => country.region.value === "Aggregates").map((country) => country.id));
}

function worldBankIndicator(options: {
  slug: string;
  name: string;
  indicator: string;
  column: string;
  unit: string;
  description: string;
  tags: string[];
  digits: number;
}): DataProductSpec {
  return {
    slug: options.slug,
    name: options.name,
    kind: "dataset",
    description: options.description,
    tags: [...options.tags, "world-bank", "countries", "macro", "development", "annual"],
    sources: [SOURCES.worldBank],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.02",
    p95Ms: 6000,
    columns: [
      { name: "iso3", type: "string", description: "ISO 3166 alpha-3 (or World Bank aggregate code)." },
      { name: "country", type: "string", description: "Country or aggregate name." },
      { name: "is_aggregate", type: "boolean", description: "True for regions and income groups." },
      { name: "year", type: "integer", description: "Year." },
      { name: options.column, type: "number", description: options.unit },
    ],
    ingest: async (ctx) => {
      const aggregates = await worldBankAggregates(ctx);
      const [, data] = await ctx.fetchJson<[unknown, WorldBankRow[] | null]>(
        `https://api.worldbank.org/v2/country/all/indicator/${options.indicator}?format=json&per_page=20000&date=1990:2030`,
        { timeoutMs: 120_000 },
      );
      return dedupe(
        (data ?? []).flatMap((row) => {
          const value = numberOrNull(row.value);
          const iso3 = row.countryiso3code || row.country.id;
          if (value === null || !iso3) return [];
          return [
            {
              iso3,
              country: row.country.value,
              is_aggregate: aggregates.has(iso3) || aggregates.has(row.country.id),
              year: Number(row.date),
              [options.column]: round(value, options.digits),
            },
          ];
        }),
        (row) => `${String(row.iso3)}|${String(row.year)}`,
      ).sort((left, right) => String(left.iso3).localeCompare(String(right.iso3)) || Number(left.year) - Number(right.year));
    },
  };
}

const WB_SNAPSHOT_SOURCES = [
  { slug: "wb-gdp", column: "gdp_usd" },
  { slug: "wb-gdp-per-capita", column: "gdp_per_capita_usd" },
  { slug: "wb-population", column: "population" },
  { slug: "wb-inflation", column: "inflation_pct" },
] as const;

export const macroProducts: DataProductSpec[] = [
  eurostatSeries({
    slug: "eu-hicp-inflation",
    name: "EU inflation (HICP) by country — monthly since 2015",
    description:
      "Harmonised consumer-price inflation (HICP, all items, annual rate of change) for every EU member, the euro area, and EU aggregates, monthly since January 2015. Clean geo/month/rate table from Eurostat.",
    tags: ["inflation", "hicp", "cpi", "prices", "euro-area"],
    dataset: "prc_hicp_manr",
    query: "coicop=CP00&unit=RCH_A&sinceTimePeriod=2015-01",
    period: "month",
    valueColumns: [{ column: "hicp_yoy_pct", filter: {}, description: "HICP all-items annual rate of change, percent." }],
  }),
  eurostatSeries({
    slug: "eu-unemployment",
    name: "EU unemployment rate by country — monthly since 2015",
    description:
      "Seasonally adjusted unemployment rate (percent of labour force, ages 15–74, both sexes) for EU countries and aggregates, monthly since 2015, from Eurostat's une_rt_m.",
    tags: ["unemployment", "labour-market", "jobs", "employment"],
    dataset: "une_rt_m",
    query: "s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT&sinceTimePeriod=2015-01",
    period: "month",
    valueColumns: [{ column: "unemployment_pct", filter: {}, description: "Unemployment rate, % of active population, SA." }],
  }),
  eurostatSeries({
    slug: "eu-gdp-growth",
    name: "EU GDP growth by country — quarterly since 2015",
    description:
      "Real GDP growth for EU countries and aggregates, quarterly since 2015: quarter-on-quarter and year-on-year percent change, chain-linked volumes, seasonally and calendar adjusted (Eurostat namq_10_gdp).",
    tags: ["gdp", "growth", "economy", "national-accounts", "quarterly"],
    dataset: "namq_10_gdp",
    query: "na_item=B1GQ&unit=CLV_PCH_PRE&unit=CLV_PCH_SM&s_adj=SCA&sinceTimePeriod=2015-Q1",
    period: "quarter",
    valueColumns: [
      { column: "gdp_qoq_pct", filter: { unit: "CLV_PCH_PRE" }, description: "Quarter-on-quarter real GDP growth, %." },
      { column: "gdp_yoy_pct", filter: { unit: "CLV_PCH_SM" }, description: "Year-on-year real GDP growth, %." },
    ],
  }),
  {
    slug: "ine-spain-cpi",
    name: "Spain CPI (IPC) — monthly index and inflation (INE)",
    kind: "dataset",
    description:
      "Spain's consumer price index (IPC general, current INE base) from INE: monthly index level plus month-on-month, year-on-year and year-to-date changes since 1993, merged into one table.",
    tags: ["spain", "ine", "cpi", "ipc", "inflation", "prices", "monthly", "espana"],
    sources: [SOURCES.ine],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "month", type: "string", description: "YYYY-MM." },
      { name: "index", type: "number", description: "IPC general index (current INE base)." },
      { name: "mom_pct", type: "number", description: "Month-on-month change, %." },
      { name: "yoy_pct", type: "number", description: "Year-on-year change, %." },
      { name: "ytd_pct", type: "number", description: "Change since December, %." },
    ],
    ingest: async (ctx) => {
      const series: [string, string][] = [
        // Current ECOICOP v2 series (table 76134); the pre-2026 IPC2518xx codes stopped at 2025-12.
        ["IPC290751", "index"],
        ["IPC290752", "mom_pct"],
        ["IPC290750", "yoy_pct"],
        ["IPC290753", "ytd_pct"],
      ];
      const byMonth = new Map<string, Row>();
      for (const [code, column] of series) {
        for (const point of await ineSeries(ctx, code, 420)) {
          if (point.FK_Periodo < 1 || point.FK_Periodo > 12) continue;
          const month = `${point.Anyo.toString()}-${point.FK_Periodo.toString().padStart(2, "0")}`;
          const row = byMonth.get(month) ?? { month, index: null, mom_pct: null, yoy_pct: null, ytd_pct: null };
          row[column] = numberOrNull(point.Valor);
          byMonth.set(month, row);
        }
        await ctx.sleep(300);
      }
      return [...byMonth.values()].sort((left, right) => String(left.month).localeCompare(String(right.month)));
    },
  },
  {
    slug: "ine-spain-unemployment",
    name: "Spain unemployment rate (EPA) — quarterly (INE)",
    kind: "dataset",
    description:
      "Spain's official unemployment rate from the Labour Force Survey (EPA, INE): national total, both sexes, quarterly since 2002.",
    tags: ["spain", "ine", "epa", "unemployment", "paro", "labour-market", "quarterly"],
    sources: [SOURCES.ine],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "quarter", type: "string", description: "YYYY-Qn." },
      { name: "unemployment_pct", type: "number", description: "Unemployment rate, % of active population." },
    ],
    ingest: async (ctx) => {
      const rows = (await ineSeries(ctx, "EPA423474", 120)).flatMap((point) => {
        // FK_Periodo 19-22 are quarters 1-4 in INE's period table.
        const quarter = point.FK_Periodo >= 19 && point.FK_Periodo <= 22 ? point.FK_Periodo - 18 : null;
        const value = numberOrNull(point.Valor);
        return quarter === null || value === null ? [] : [{ quarter: `${point.Anyo.toString()}-Q${quarter.toString()}`, unemployment_pct: value }];
      });
      return dedupe(rows, (row) => String(row.quarter)).sort((left, right) => String(left.quarter).localeCompare(String(right.quarter)));
    },
  },
  worldBankIndicator({
    slug: "wb-gdp",
    name: "GDP by country (current US$) — World Bank, 1990–latest",
    indicator: "NY.GDP.MKTP.CD",
    column: "gdp_usd",
    unit: "GDP at market prices, current US$.",
    description: "Gross domestic product in current US dollars for ~217 economies and World Bank aggregates, annual since 1990 (World Development Indicators).",
    tags: ["gdp", "economy", "growth"],
    digits: 0,
  }),
  worldBankIndicator({
    slug: "wb-gdp-per-capita",
    name: "GDP per capita by country (current US$) — World Bank",
    indicator: "NY.GDP.PCAP.CD",
    column: "gdp_per_capita_usd",
    unit: "GDP per capita, current US$.",
    description: "GDP per capita in current US dollars for every country and aggregate, annual since 1990 (World Development Indicators).",
    tags: ["gdp-per-capita", "income", "economy"],
    digits: 2,
  }),
  worldBankIndicator({
    slug: "wb-population",
    name: "Population by country — World Bank, 1990–latest",
    indicator: "SP.POP.TOTL",
    column: "population",
    unit: "Total population.",
    description: "Total population for every country and aggregate, annual since 1990 (World Development Indicators).",
    tags: ["population", "demographics"],
    digits: 0,
  }),
  worldBankIndicator({
    slug: "wb-inflation",
    name: "Inflation (CPI, annual %) by country — World Bank",
    indicator: "FP.CPI.TOTL.ZG",
    column: "inflation_pct",
    unit: "Consumer price inflation, annual %.",
    description: "Annual consumer-price inflation for every country with data, since 1990 (World Development Indicators).",
    tags: ["inflation", "cpi", "prices"],
    digits: 3,
  }),
  {
    slug: "country-economy-snapshot",
    name: "Country economy snapshot — GDP, per-capita, population, inflation (lookup)",
    kind: "lookup",
    description:
      "One call returns the latest GDP, GDP per capita, population and inflation for a country (by name or ISO3), with the year of each figure. Built from the World Bank datasets Roster refreshes weekly.",
    tags: ["country", "economy", "gdp", "population", "inflation", "snapshot", "world-bank"],
    sources: [SOURCES.worldBank],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "iso3", type: "string", description: "ISO 3166 alpha-3." },
      { name: "country", type: "string", description: "Country name." },
      ...WB_SNAPSHOT_SOURCES.flatMap((source) => [
        { name: source.column, type: "number" as const, description: `Latest ${source.column}.` },
        { name: `${source.column}_year`, type: "integer" as const, description: `Year of ${source.column}.` },
      ]),
    ],
    input: { country: { type: "string", description: "Country name or ISO 3166 alpha-3 code." } },
    required: ["country"],
    example: { country: "Spain" },
    lookup: async (input, ctx) => {
      const query = str(input, "country", 80);
      if (!query) return [];
      const folded = fold(query);
      const upper = query.toUpperCase();
      const out: Row = {};
      let iso3: string | null = null;
      for (const source of WB_SNAPSHOT_SOURCES) {
        const rows = await ctx.rowsOf(source.slug);
        if (!iso3) {
          const hit =
            rows.find((row) => row.iso3 === upper) ??
            rows.find((row) => fold(String(row.country)) === folded) ??
            rows.find((row) => !row.is_aggregate && fold(String(row.country)).includes(folded));
          if (!hit) continue;
          iso3 = String(hit.iso3);
          out.iso3 = iso3;
          out.country = hit.country ?? null;
        }
        const latest = rows.filter((row) => row.iso3 === iso3).sort((left, right) => Number(right.year) - Number(left.year))[0];
        out[source.column] = latest?.[source.column] ?? null;
        out[`${source.column}_year`] = latest?.year ?? null;
      }
      return iso3 ? [out] : [];
    },
  },
  {
    slug: "owid-co2",
    name: "CO₂ and greenhouse-gas emissions by country — Our World in Data",
    kind: "dataset",
    description:
      "Annual CO₂ emissions by country since 1950: total, per capita, share of global, by fuel (coal, oil, gas, cement), total greenhouse gases, plus population and GDP. Trimmed from the full OWID file to the most-used columns.",
    tags: ["co2", "emissions", "climate", "greenhouse-gas", "carbon", "esg", "countries", "owid"],
    sources: [SOURCES.owid],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.03",
    p95Ms: 6000,
    columns: [
      { name: "country", type: "string", description: "Country or region." },
      { name: "iso3", type: "string", description: "ISO 3166 alpha-3 (null for regions)." },
      { name: "year", type: "integer", description: "Year." },
      ...[
        ["population", "Population."],
        ["gdp", "GDP (international $, 2011 prices)."],
        ["co2", "CO₂ emissions, million tonnes."],
        ["co2_per_capita", "CO₂ per person, tonnes."],
        ["share_global_co2", "Share of global CO₂, %."],
        ["coal_co2", "CO₂ from coal, Mt."],
        ["oil_co2", "CO₂ from oil, Mt."],
        ["gas_co2", "CO₂ from gas, Mt."],
        ["cement_co2", "CO₂ from cement, Mt."],
        ["total_ghg", "Total greenhouse gases incl. land use, Mt CO₂e."],
      ].map(([name, description]) => ({ name: name ?? "", type: "number" as const, description: description ?? "" })),
    ],
    ingest: async (ctx) => {
      const csv = await ctx.fetchText("https://raw.githubusercontent.com/owid/co2-data/master/owid-co2-data.csv", { timeoutMs: 120_000 });
      const keep = ["population", "gdp", "co2", "co2_per_capita", "share_global_co2", "coal_co2", "oil_co2", "gas_co2", "cement_co2", "total_ghg"];
      return parseCsv(csv).flatMap((record) => {
        const year = Number(record.year);
        if (!record.country || !Number.isInteger(year) || year < 1950) return [];
        const row: Row = { country: record.country, iso3: record.iso_code || null, year };
        for (const column of keep) row[column] = numberOrNull(record[column]);
        return row.co2 === null && row.total_ghg === null ? [] : [row];
      });
    },
  },
];
