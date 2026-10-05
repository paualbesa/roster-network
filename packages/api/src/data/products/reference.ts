import { SOURCES } from "../sources.js";
import type { DataFetchContext, DataProductSpec, Row } from "../types.js";
import { fold, intIn, numberOrNull, parseCsv, str, textOrNull, unzipEntry } from "../util.js";

const DAY = 86_400;

type SparqlBinding = Record<string, { value: string } | undefined>;

async function sparql(ctx: DataFetchContext, query: string): Promise<SparqlBinding[]> {
  const body = new URLSearchParams({ query });
  const data = await ctx.fetchJson<{ results: { bindings: SparqlBinding[] } }>("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    timeoutMs: 90_000,
  });
  return data.results.bindings;
}

const v = (binding: SparqlBinding, key: string): string | null => textOrNull(binding[key]?.value ?? null);
const list = (binding: SparqlBinding, key: string): string | null => {
  const value = v(binding, key);
  if (!value) return null;
  return [...new Set(value.split(";").map((part) => part.trim()).filter(Boolean))].sort().join(";") || null;
};
const qid = (binding: SparqlBinding, key = "item"): string | null => v(binding, key)?.replace(/^.*\//, "") ?? null;

function filled(row: Row): number {
  return Object.values(row).filter((value) => value !== null && value !== "").length;
}

/** Keep the most complete row per key. */
function bestBy(rows: Row[], key: (row: Row) => string): Row[] {
  const best = new Map<string, Row>();
  for (const row of rows) {
    const id = key(row);
    const current = best.get(id);
    if (!current || filled(row) > filled(current)) best.set(id, row);
  }
  return [...best.values()];
}

const COUNTRIES_QUERY = `SELECT ?item ?name ?iso2 ?iso3 ?isoNum (SAMPLE(?capLabel) AS ?capital) (MAX(?pop) AS ?population) (MAX(?areaV) AS ?area)
  (GROUP_CONCAT(DISTINCT ?cur; separator=";") AS ?currencies) (GROUP_CONCAT(DISTINCT ?call; separator=";") AS ?calling)
  (GROUP_CONCAT(DISTINCT ?tldLabel; separator=";") AS ?tlds) (GROUP_CONCAT(DISTINCT ?contLabel; separator=";") AS ?continents)
WHERE {
  ?item wdt:P297 ?iso2 .
  ?item rdfs:label ?name . FILTER(LANG(?name) = "en")
  OPTIONAL { ?item wdt:P298 ?iso3 }
  OPTIONAL { ?item wdt:P299 ?isoNum }
  OPTIONAL { ?item wdt:P36 ?cap . ?cap rdfs:label ?capLabel . FILTER(LANG(?capLabel) = "en") }
  OPTIONAL { ?item wdt:P1082 ?pop }
  OPTIONAL { ?item wdt:P2046 ?areaV }
  OPTIONAL { ?item p:P38 ?cs . ?cs ps:P38 ?c . ?c wdt:P498 ?cur . FILTER NOT EXISTS { ?cs pq:P582 ?csEnd } FILTER NOT EXISTS { ?c wdt:P582 ?cEnd } }
  OPTIONAL { ?item wdt:P474 ?call }
  OPTIONAL { ?item wdt:P78 ?tld . ?tld rdfs:label ?tldLabel . FILTER(LANG(?tldLabel) = "en") }
  OPTIONAL { ?item wdt:P30 ?cont . ?cont rdfs:label ?contLabel . FILTER(LANG(?contLabel) = "en") }
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
}
GROUP BY ?item ?name ?iso2 ?iso3 ?isoNum`;

const CURRENCIES_QUERY = `SELECT ?item ?code ?name (SAMPLE(?sym) AS ?symbol) (GROUP_CONCAT(DISTINCT ?iso2; separator=";") AS ?countries)
WHERE {
  ?item wdt:P498 ?code .
  ?item rdfs:label ?name . FILTER(LANG(?name) = "en")
  OPTIONAL { ?item wdt:P5061 ?sym }
  OPTIONAL { ?country wdt:P38 ?item . ?country wdt:P297 ?iso2 . FILTER NOT EXISTS { ?country wdt:P576 ?gone } }
  FILTER NOT EXISTS { ?item wdt:P582 ?ended }
}
GROUP BY ?item ?code ?name`;

const LANGUAGES_QUERY = `SELECT ?item ?name ?iso1 (SAMPLE(?i2) AS ?iso2) (SAMPLE(?i3) AS ?iso3) (SAMPLE(?native) AS ?nativeName) (MAX(?spk) AS ?speakers)
WHERE {
  ?item wdt:P218 ?iso1 .
  ?item rdfs:label ?name . FILTER(LANG(?name) = "en")
  OPTIONAL { ?item wdt:P219 ?i2 }
  OPTIONAL { ?item wdt:P220 ?i3 }
  OPTIONAL { ?item wdt:P1705 ?native }
  OPTIONAL { ?item wdt:P1098 ?spk }
}
GROUP BY ?item ?name ?iso1`;

const CITY_COLUMNS = [
  "geonameid",
  "name",
  "asciiname",
  "alternatenames",
  "latitude",
  "longitude",
  "feature_class",
  "feature_code",
  "country_code",
  "cc2",
  "admin1",
  "admin2",
  "admin3",
  "admin4",
  "population",
  "elevation",
  "dem",
  "timezone",
  "modified",
];

function lookupMatches(rows: readonly Row[], query: string, fields: string[], exactFields: string[], limit: number): Row[] {
  const upper = query.trim().toUpperCase();
  const folded = fold(query);
  if (!folded) return [];
  const exact = rows.filter((row) => exactFields.some((field) => String(row[field] ?? "").toUpperCase() === upper));
  const named = rows.filter(
    (row) => !exact.includes(row) && fields.some((field) => fold(String(row[field] ?? "")) === folded),
  );
  const partial = rows.filter(
    (row) => !exact.includes(row) && !named.includes(row) && fields.some((field) => fold(String(row[field] ?? "")).startsWith(folded)),
  );
  const byPopulation = (left: Row, right: Row) => Number(right.population ?? 0) - Number(left.population ?? 0);
  return [...exact, ...named.sort(byPopulation), ...partial.sort(byPopulation)].slice(0, limit);
}

export const referenceProducts: DataProductSpec[] = [
  {
    slug: "countries",
    name: "Countries reference table — ISO codes, capitals, currencies, calling codes",
    kind: "dataset",
    description:
      "Every current country and territory with an ISO 3166-1 code: alpha-2, alpha-3, numeric, English name, capital, population, area, ISO 4217 currencies, calling codes, top-level domains and continent. Deduplicated from Wikidata. The table every app needs.",
    tags: ["countries", "iso-3166", "reference", "geography", "currencies", "calling-codes", "lookup-table"],
    sources: [SOURCES.wikidata],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "iso2", type: "string", description: "ISO 3166-1 alpha-2." },
      { name: "iso3", type: "string", description: "ISO 3166-1 alpha-3." },
      { name: "iso_numeric", type: "string", description: "ISO 3166-1 numeric." },
      { name: "name", type: "string", description: "English name." },
      { name: "capital", type: "string", description: "Capital city." },
      { name: "population", type: "integer", description: "Latest population on Wikidata." },
      { name: "area_km2", type: "number", description: "Area, km²." },
      { name: "currencies", type: "string", description: "ISO 4217 codes, semicolon-separated." },
      { name: "calling_codes", type: "string", description: "Country calling codes." },
      { name: "tlds", type: "string", description: "Internet ccTLDs." },
      { name: "continents", type: "string", description: "Continents." },
      { name: "wikidata_id", type: "string", description: "Wikidata QID." },
    ],
    ingest: async (ctx) => {
      const rows = (await sparql(ctx, COUNTRIES_QUERY)).map((binding) => ({
        iso2: v(binding, "iso2"),
        iso3: v(binding, "iso3"),
        iso_numeric: v(binding, "isoNum"),
        name: v(binding, "name"),
        capital: v(binding, "capital"),
        population: numberOrNull(v(binding, "population")),
        area_km2: numberOrNull(v(binding, "area")),
        currencies: list(binding, "currencies"),
        calling_codes: list(binding, "calling"),
        tlds: list(binding, "tlds"),
        continents: list(binding, "continents"),
        wikidata_id: qid(binding),
      }));
      return bestBy(
        rows.filter((row) => row.iso2 && /^[A-Z]{2}$/.test(String(row.iso2))),
        (row) => String(row.iso2),
      ).sort((left, right) => String(left.iso2).localeCompare(String(right.iso2)));
    },
  },
  {
    slug: "currencies",
    name: "Currencies reference table — ISO 4217 codes, names, symbols, countries",
    kind: "dataset",
    description:
      "Active ISO 4217 currencies with code, English name, symbol and the ISO 3166 countries that use each one. Cleaned from Wikidata (historical currencies removed).",
    tags: ["currencies", "iso-4217", "reference", "money", "symbols", "lookup-table"],
    sources: [SOURCES.wikidata],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.005",
    p95Ms: 6000,
    columns: [
      { name: "code", type: "string", description: "ISO 4217 alphabetic code." },
      { name: "name", type: "string", description: "English name." },
      { name: "symbol", type: "string", description: "Currency symbol." },
      { name: "countries", type: "string", description: "ISO 3166 alpha-2 users, semicolon-separated." },
      { name: "wikidata_id", type: "string", description: "Wikidata QID." },
    ],
    ingest: async (ctx) => {
      const rows = (await sparql(ctx, CURRENCIES_QUERY)).map((binding) => ({
        code: v(binding, "code"),
        name: v(binding, "name"),
        symbol: v(binding, "symbol"),
        countries: list(binding, "countries"),
        wikidata_id: qid(binding),
      }));
      return bestBy(
        rows.filter((row) => /^[A-Z]{3}$/.test(String(row.code))),
        (row) => String(row.code),
      ).sort((left, right) => String(left.code).localeCompare(String(right.code)));
    },
  },
  {
    slug: "languages",
    name: "Languages reference table — ISO 639-1/2/3 codes, native names, speakers",
    kind: "dataset",
    description:
      "Every language with an ISO 639-1 code: ISO 639-1, 639-2 and 639-3 codes, English and native names, and number of speakers when known. From Wikidata.",
    tags: ["languages", "iso-639", "reference", "i18n", "localization", "lookup-table"],
    sources: [SOURCES.wikidata],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.005",
    p95Ms: 6000,
    columns: [
      { name: "iso639_1", type: "string", description: "Two-letter code." },
      { name: "iso639_2", type: "string", description: "Three-letter bibliographic code." },
      { name: "iso639_3", type: "string", description: "Three-letter ISO 639-3 code." },
      { name: "name", type: "string", description: "English name." },
      { name: "native_name", type: "string", description: "Name in the language itself." },
      { name: "speakers", type: "integer", description: "Speakers (Wikidata, when known)." },
      { name: "wikidata_id", type: "string", description: "Wikidata QID." },
    ],
    ingest: async (ctx) => {
      const rows = (await sparql(ctx, LANGUAGES_QUERY)).map((binding) => ({
        iso639_1: v(binding, "iso1"),
        iso639_2: v(binding, "iso2"),
        iso639_3: v(binding, "iso3"),
        name: v(binding, "name"),
        native_name: v(binding, "nativeName"),
        speakers: numberOrNull(v(binding, "speakers")),
        wikidata_id: qid(binding),
      }));
      return bestBy(
        rows.filter((row) => /^[a-z]{2}$/.test(String(row.iso639_1))),
        (row) => String(row.iso639_1),
      ).sort((left, right) => String(left.iso639_1).localeCompare(String(right.iso639_1)));
    },
  },
  {
    slug: "timezones",
    name: "Time zones table — IANA zones with current UTC offset and DST",
    kind: "dataset",
    description:
      "All canonical IANA time zones with their current UTC offset, standard and daylight offsets this year, whether DST is active now, and the abbreviation. Recomputed daily so offsets track DST switches.",
    tags: ["timezones", "iana", "tzdb", "utc-offset", "dst", "reference", "scheduling"],
    sources: [SOURCES.iana],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.002",
    p95Ms: 6000,
    columns: [
      { name: "zone", type: "string", description: "IANA zone id, e.g. Europe/Madrid." },
      { name: "region", type: "string", description: "First path segment (continent/ocean)." },
      { name: "utc_offset_now", type: "string", description: "Current offset, ±HH:MM." },
      { name: "offset_minutes_now", type: "integer", description: "Current offset in minutes." },
      { name: "standard_offset_minutes", type: "integer", description: "Smaller of January/July offsets." },
      { name: "dst_offset_minutes", type: "integer", description: "Larger of January/July offsets." },
      { name: "observes_dst", type: "boolean", description: "Offsets differ between January and July." },
      { name: "dst_active_now", type: "boolean", description: "Currently on daylight time." },
      { name: "abbreviation_now", type: "string", description: "Short name right now (e.g. CEST)." },
    ],
    ingest: async (ctx) => {
      const now = ctx.now();
      const year = now.getUTCFullYear();
      const offset = (zone: string, at: Date): number => {
        const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
          .formatToParts(at)
          .find((item) => item.type === "timeZoneName")?.value;
        const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? "");
        if (!match) return 0;
        const minutes = Number(match[2]) * 60 + Number(match[3] ?? "0");
        return match[1] === "-" ? -minutes : minutes;
      };
      const format = (minutes: number): string => {
        const sign = minutes < 0 ? "-" : "+";
        const absolute = Math.abs(minutes);
        return `${sign}${Math.floor(absolute / 60).toString().padStart(2, "0")}:${(absolute % 60).toString().padStart(2, "0")}`;
      };
      return Intl.supportedValuesOf("timeZone").map((zone) => {
        const january = offset(zone, new Date(Date.UTC(year, 0, 15)));
        const july = offset(zone, new Date(Date.UTC(year, 6, 15)));
        const current = offset(zone, now);
        const abbreviation =
          new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
            .formatToParts(now)
            .find((item) => item.type === "timeZoneName")?.value ?? null;
        return {
          zone,
          region: zone.split("/")[0] ?? zone,
          utc_offset_now: format(current),
          offset_minutes_now: current,
          standard_offset_minutes: Math.min(january, july),
          dst_offset_minutes: Math.max(january, july),
          observes_dst: january !== july,
          dst_active_now: january !== july && current === Math.max(january, july),
          abbreviation_now: abbreviation,
        };
      });
    },
  },
  {
    slug: "world-cities",
    name: "World cities ≥15k population — coordinates, country, timezone (GeoNames)",
    kind: "dataset",
    description:
      "All ~33,000 cities with 15,000+ inhabitants worldwide: name, ASCII name, latitude/longitude, ISO country, admin-1 code, population, elevation and IANA time zone. Cleaned from GeoNames cities15000.",
    tags: ["cities", "geonames", "geography", "geocoding", "coordinates", "population", "timezone"],
    sources: [SOURCES.geonames],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.03",
    p95Ms: 6000,
    columns: [
      { name: "geonameid", type: "integer", description: "GeoNames id." },
      { name: "name", type: "string", description: "City name." },
      { name: "ascii_name", type: "string", description: "ASCII name." },
      { name: "country_code", type: "string", description: "ISO 3166 alpha-2." },
      { name: "admin1", type: "string", description: "First-level admin code." },
      { name: "latitude", type: "number", description: "WGS84 latitude." },
      { name: "longitude", type: "number", description: "WGS84 longitude." },
      { name: "population", type: "integer", description: "Population." },
      { name: "elevation_m", type: "integer", description: "Elevation (DEM), metres." },
      { name: "timezone", type: "string", description: "IANA time zone." },
    ],
    ingest: async (ctx) => {
      const archive = await ctx.fetchBytes("https://download.geonames.org/export/dump/cities15000.zip", { timeoutMs: 120_000 });
      const text = new TextDecoder().decode(unzipEntry(archive, "cities15000.txt"));
      return text.split("\n").flatMap((line) => {
        const cells = line.split("\t");
        if (cells.length < CITY_COLUMNS.length) return [];
        const get = (column: string) => cells[CITY_COLUMNS.indexOf(column)] ?? "";
        return [
          {
            geonameid: Number(get("geonameid")),
            name: textOrNull(get("name")),
            ascii_name: textOrNull(get("asciiname")),
            country_code: textOrNull(get("country_code")),
            admin1: textOrNull(get("admin1")),
            latitude: numberOrNull(get("latitude")),
            longitude: numberOrNull(get("longitude")),
            population: numberOrNull(get("population")),
            elevation_m: numberOrNull(get("dem")),
            timezone: textOrNull(get("timezone")),
          },
        ];
      });
    },
  },
  {
    slug: "city-lookup",
    name: "City geocoder — coordinates, country, population, timezone (lookup)",
    kind: "lookup",
    description:
      "Resolve a city name (any spelling, accents optional, optional country filter) to coordinates, ISO country, population and IANA time zone. Ranked by exact match then population. Backed by Roster's GeoNames world-cities table.",
    tags: ["geocoding", "cities", "coordinates", "timezone", "geonames", "location"],
    sources: [SOURCES.geonames],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.001",
    p95Ms: 6000,
    columns: [
      { name: "name", type: "string", description: "City." },
      { name: "country_code", type: "string", description: "ISO alpha-2." },
      { name: "latitude", type: "number", description: "Latitude." },
      { name: "longitude", type: "number", description: "Longitude." },
      { name: "population", type: "integer", description: "Population." },
      { name: "timezone", type: "string", description: "IANA zone." },
    ],
    input: {
      query: { type: "string", description: "City name." },
      country: { type: "string", description: "Optional ISO alpha-2 filter." },
      limit: { type: "integer" },
    },
    required: ["query"],
    example: { query: "Barcelona", country: "ES" },
    lookup: async (input, ctx) => {
      const country = str(input, "country", 2).toUpperCase();
      const rows = (await ctx.rowsOf("world-cities")).filter((row) => !country || row.country_code === country);
      return lookupMatches(rows, str(input, "query", 120), ["name", "ascii_name"], [], intIn(input, "limit", 5, 1, 25));
    },
  },
  {
    slug: "airports",
    name: "Airports worldwide — IATA/ICAO codes, coordinates, type (OurAirports)",
    kind: "dataset",
    description:
      "Every airport, heliport and seaplane base in OurAirports (~80,000): ICAO/GPS ident, IATA code, name, type, coordinates, elevation, ISO country and region, municipality and scheduled-service flag. Closed airports removed.",
    tags: ["airports", "iata", "icao", "aviation", "travel", "geography", "ourairports"],
    sources: [SOURCES.ourAirports],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.03",
    p95Ms: 6000,
    columns: [
      { name: "ident", type: "string", description: "ICAO or local ident." },
      { name: "iata", type: "string", description: "IATA code." },
      { name: "name", type: "string", description: "Airport name." },
      { name: "type", type: "string", description: "large_airport, medium_airport, small_airport, heliport…" },
      { name: "latitude", type: "number", description: "Latitude." },
      { name: "longitude", type: "number", description: "Longitude." },
      { name: "elevation_ft", type: "integer", description: "Elevation, feet." },
      { name: "country_code", type: "string", description: "ISO alpha-2." },
      { name: "region_code", type: "string", description: "ISO 3166-2 region." },
      { name: "municipality", type: "string", description: "City served." },
      { name: "scheduled_service", type: "boolean", description: "Has scheduled airline service." },
    ],
    ingest: async (ctx) => {
      const csv = await ctx.fetchText("https://davidmegginson.github.io/ourairports-data/airports.csv", { timeoutMs: 120_000 });
      return parseCsv(csv).flatMap((record) => {
        if (!record.ident || record.type === "closed" || record.iso_country === "ZZ") return [];
        return [
          {
            ident: record.ident,
            iata: textOrNull(record.iata_code),
            name: textOrNull(record.name),
            type: textOrNull(record.type),
            latitude: numberOrNull(record.latitude_deg),
            longitude: numberOrNull(record.longitude_deg),
            elevation_ft: numberOrNull(record.elevation_ft),
            country_code: textOrNull(record.iso_country),
            region_code: textOrNull(record.iso_region),
            municipality: textOrNull(record.municipality),
            scheduled_service: record.scheduled_service === "yes",
          },
        ];
      });
    },
  },
  {
    slug: "airport-lookup",
    name: "Airport code lookup — IATA/ICAO to name, city, coordinates (lookup)",
    kind: "lookup",
    description:
      "Resolve an IATA (BCN) or ICAO (LEBL) code, or an airport/city name, to the airport's name, city, country, coordinates, elevation and type. Prefers airports with scheduled service.",
    tags: ["airports", "iata", "icao", "lookup", "aviation", "travel"],
    sources: [SOURCES.ourAirports],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.001",
    p95Ms: 6000,
    columns: [
      { name: "iata", type: "string", description: "IATA." },
      { name: "ident", type: "string", description: "ICAO/ident." },
      { name: "name", type: "string", description: "Name." },
      { name: "municipality", type: "string", description: "City." },
      { name: "country_code", type: "string", description: "Country." },
      { name: "latitude", type: "number", description: "Latitude." },
      { name: "longitude", type: "number", description: "Longitude." },
    ],
    input: { query: { type: "string", description: "IATA, ICAO, airport or city name." }, limit: { type: "integer" } },
    required: ["query"],
    example: { query: "BCN" },
    lookup: async (input, ctx) => {
      const rows = await ctx.rowsOf("airports");
      const ranked = lookupMatches(rows, str(input, "query", 120), ["name", "municipality"], ["iata", "ident"], 200);
      const weight = (row: Row) => (row.scheduled_service ? 0 : 1) + (row.type === "large_airport" ? 0 : row.type === "medium_airport" ? 0.5 : 1);
      const exactCount = ranked.filter((row) => [row.iata, row.ident].some((code) => String(code ?? "").toUpperCase() === str(input, "query").toUpperCase())).length;
      const rest = ranked.slice(exactCount).sort((left, right) => weight(left) - weight(right));
      return [...ranked.slice(0, exactCount), ...rest].slice(0, intIn(input, "limit", 5, 1, 25));
    },
  },
  {
    slug: "uk-bank-holidays",
    name: "UK bank holidays — England & Wales, Scotland, Northern Ireland (GOV.UK)",
    kind: "dataset",
    description:
      "Official UK bank holidays for England and Wales, Scotland and Northern Ireland from GOV.UK, past and announced future dates, with substitute-day notes. Use it for business-day calculations and SLAs.",
    tags: ["holidays", "bank-holidays", "uk", "calendar", "business-days", "public-holidays"],
    sources: [SOURCES.govUk],
    cadence: "weekly",
    intervalS: 7 * DAY,
    priceUsdc: "0.002",
    p95Ms: 6000,
    columns: [
      { name: "date", type: "date", description: "Holiday date." },
      { name: "division", type: "string", description: "england-and-wales, scotland, northern-ireland." },
      { name: "title", type: "string", description: "Holiday name." },
      { name: "notes", type: "string", description: "e.g. Substitute day." },
    ],
    ingest: async (ctx) => {
      const data = await ctx.fetchJson<Record<string, { division: string; events: { title: string; date: string; notes: string }[] }>>(
        "https://www.gov.uk/bank-holidays.json",
      );
      return Object.values(data)
        .flatMap((division) =>
          division.events.map((event) => ({
            date: event.date,
            division: division.division,
            title: textOrNull(event.title),
            notes: textOrNull(event.notes),
          })),
        )
        .sort((left, right) => left.date.localeCompare(right.date) || left.division.localeCompare(right.division));
    },
  },
];
