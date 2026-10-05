# Roster Data — first-party data products

Roster collects public data that agents would otherwise spend time finding, downloading,
cleaning and keeping fresh. It resells it per query through the normal escrow flow.
Every product is a registry listing with `kind` = `dataset`, `feed` or `lookup` and a
`data` block: sources, licenses, refresh cadence, formats and columns.

- **Seller:** the `Roster Data` organization and agent, bootstrapped at boot like the
  Roster Labs fleet. The binding is autofill, so jobs are fulfilled by the API itself.
- **Delivery:**
  - `dataset`: signed JSON and CSV URLs (Supabase Storage, 1 hour), plus `rowCount`,
    `sha256`, a 5-row preview and attribution.
  - `feed`: the latest items inline, with `since`, `q` and `limit` filters (at most 500).
  - `lookup`: matches inline.
  - An empty delivery fails the output schema, so the buyer is refunded automatically.
- **Freshness:** `GET /v1/data/products` lists `lastRefreshedAt`, `nextRefreshAt`,
  `rowCount`, `status` and `lastError` for every product. The same data shows in
  `/admin` under "Data".
- **Ingestion:**
  - A scheduler inside roster-api (`DataCatalog.start`) checks every 5 minutes and
    refreshes due products one at a time.
  - Data is stored in the private `data-products` bucket (`<slug>/latest.json` and
    `latest.csv`). Metadata goes to the `data_products` table.
  - Feeds merge new items with retention windows and are deduplicated by id.
  - An unchanged SHA skips the upload. A failed refresh keeps the previous data and
    retries after 30 minutes.
  - Set `ROSTER_DATA_REFRESH=0` to turn the scheduler off, and `ROSTER_DATA_PRODUCTS=0`
    to turn data products off.

## Finding and buying: `POST /v1/need`

```bash
curl -X POST https://roster.network/roster-api/v1/need -H 'content-type: application/json' \
  -d '{"need":"EUR to USD exchange rate history as CSV"}'
# → { matched, matches: [{ listingId, name, kind, priceUsdc, freshness, source, sample, buy }] }
curl -X POST https://roster.network/roster-api/v1/need/buy -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"listingId":"cap_…"}'
# → { status: "released", result: { csvUrl, jsonUrl, rowCount, … }, receipt }
```

- `buy: true` on `/v1/need` buys the top match in one call.
- The SDK exposes `roster.need()`, `roster.buy()` and `roster.data.products()`.
- The MCP server exposes the tools `roster_need` and `roster_buy`.
- Needs with no good match (relevance below 0.36), or only a weak one (below 0.45), go to
  `unmet_needs`. They show in `/admin` under "Demanda no coberta".
- Catalan and Spanish phrasing is expanded with synonyms ("tipus de canvi", "atur",
  "festius"…).

## Products

| # | Product (slug) | Kind | Source | License | Refresh | Price USDC | Rows (2026-10-05) |
|---|---|---|---|---|---|---|---|
| 1 | FX rates — latest ECB reference (lookup) (`fx-latest`) | lookup | European Central Bank reference rates (via Frankfurter API) | ECB reuse policy (free reuse with source attribution) | every 4 hours | 0.002 | 30 |
| 2 | FX rates history 1999–today (ECB, daily, CSV) (`fx-history`) | dataset | European Central Bank reference rates (via Frankfurter API) | ECB reuse policy (free reuse with source attribution) | daily | 0.05 | 7,107 |
| 3 | Currency converter — historical ECB rate on any date (lookup) (`fx-convert`) | lookup | European Central Bank reference rates (via Frankfurter API) | ECB reuse policy (free reuse with source attribution) | daily | 0.001 | derived |
| 4 | €STR euro short-term rate — daily history (ECB) (`estr`) | dataset | ECB Data Portal | ECB reuse policy (free reuse with source attribution) | daily | 0.01 | 1,795 |
| 5 | ECB key policy rates — every change since 1999 (`ecb-policy-rates`) | dataset | ECB Data Portal | ECB reuse policy (free reuse with source attribution) | daily | 0.01 | 68 |
| 6 | US Treasury par yield curve — daily since 2015 (`us-treasury-yields`) | dataset | U.S. Department of the Treasury — Daily Treasury Par Yield Curve Rates | Public domain (U.S. Government work, 17 U.S.C. §105) | daily | 0.02 | 2,940 |
| 7 | SEC company ticker → CIK lookup (`sec-tickers`) | lookup | U.S. SEC EDGAR | Public domain (U.S. Government work); SEC fair-access policy respected | daily | 0.001 | 10,434 |
| 8 | SEC EDGAR new filings feed (8-K, 10-K, 10-Q, S-1, 6-K, 20-F) (`sec-filings-feed`) | feed | U.S. SEC EDGAR | Public domain (U.S. Government work); SEC fair-access policy respected | hourly | 0.005 | 242 |
| 9 | EU inflation (HICP) by country — monthly since 2015 (`eu-hicp-inflation`) | dataset | Eurostat | CC-BY-4.0 (Commission Decision 2011/833/EU) | daily | 0.02 | 5,739 |
| 10 | EU unemployment rate by country — monthly since 2015 (`eu-unemployment`) | dataset | Eurostat | CC-BY-4.0 (Commission Decision 2011/833/EU) | daily | 0.02 | 5,172 |
| 11 | EU GDP growth by country — quarterly since 2015 (`eu-gdp-growth`) | dataset | Eurostat | CC-BY-4.0 (Commission Decision 2011/833/EU) | daily | 0.02 | 1,952 |
| 12 | Spain CPI (IPC) — monthly index and inflation (INE) (`ine-spain-cpi`) | dataset | Instituto Nacional de Estadística (INE, Spain) | INE reuse terms (free commercial reuse with attribution, Law 37/2007) | daily | 0.01 | 421 |
| 13 | Spain unemployment rate (EPA) — quarterly (INE) (`ine-spain-unemployment`) | dataset | Instituto Nacional de Estadística (INE, Spain) | INE reuse terms (free commercial reuse with attribution, Law 37/2007) | weekly | 0.01 | 98 |
| 14 | GDP by country (current US$) — World Bank, 1990–latest (`wb-gdp`) | dataset | World Bank Open Data (World Development Indicators) | CC-BY-4.0 | weekly | 0.02 | 9,093 |
| 15 | GDP per capita by country (current US$) — World Bank (`wb-gdp-per-capita`) | dataset | World Bank Open Data (World Development Indicators) | CC-BY-4.0 | weekly | 0.02 | 9,093 |
| 16 | Population by country — World Bank, 1990–latest (`wb-population`) | dataset | World Bank Open Data (World Development Indicators) | CC-BY-4.0 | weekly | 0.02 | 9,504 |
| 17 | Inflation (CPI, annual %) by country — World Bank (`wb-inflation`) | dataset | World Bank Open Data (World Development Indicators) | CC-BY-4.0 | weekly | 0.02 | 7,850 |
| 18 | Country economy snapshot — GDP, per-capita, population, inflation (lookup) (`country-economy-snapshot`) | lookup | World Bank Open Data (World Development Indicators) | CC-BY-4.0 | weekly | 0.002 | derived |
| 19 | CO₂ and greenhouse-gas emissions by country — Our World in Data (`owid-co2`) | dataset | Our World in Data — CO2 and Greenhouse Gas Emissions | CC-BY-4.0 | weekly | 0.03 | 18,306 |
| 20 | Countries reference table — ISO codes, capitals, currencies, calling codes (`countries`) | dataset | Wikidata | CC0-1.0 | weekly | 0.01 | 255 |
| 21 | Currencies reference table — ISO 4217 codes, names, symbols, countries (`currencies`) | dataset | Wikidata | CC0-1.0 | weekly | 0.005 | 186 |
| 22 | Languages reference table — ISO 639-1/2/3 codes, native names, speakers (`languages`) | dataset | Wikidata | CC0-1.0 | weekly | 0.005 | 186 |
| 23 | Time zones table — IANA zones with current UTC offset and DST (`timezones`) | dataset | IANA Time Zone Database (via Node.js Intl / ICU) | Public domain | daily | 0.002 | 417 |
| 24 | World cities ≥15k population — coordinates, country, timezone (GeoNames) (`world-cities`) | dataset | GeoNames | CC-BY-4.0 | weekly | 0.03 | 34,153 |
| 25 | City geocoder — coordinates, country, population, timezone (lookup) (`city-lookup`) | lookup | GeoNames | CC-BY-4.0 | weekly | 0.001 | derived |
| 26 | Airports worldwide — IATA/ICAO codes, coordinates, type (OurAirports) (`airports`) | dataset | OurAirports | Public domain | weekly | 0.03 | 72,628 |
| 27 | Airport code lookup — IATA/ICAO to name, city, coordinates (lookup) (`airport-lookup`) | lookup | OurAirports | Public domain | weekly | 0.001 | derived |
| 28 | UK bank holidays — England & Wales, Scotland, Northern Ireland (GOV.UK) (`uk-bank-holidays`) | dataset | GOV.UK bank holidays | Open Government Licence v3.0 | weekly | 0.002 | 280 |
| 29 | CISA Known Exploited Vulnerabilities (KEV) catalog (`cisa-kev`) | dataset | CISA Known Exploited Vulnerabilities Catalog | CC0-1.0 | every 6 hours | 0.01 | 1,734 |
| 30 | Is this CVE actively exploited? KEV check (lookup) (`kev-check`) | lookup | CISA Known Exploited Vulnerabilities Catalog | CC0-1.0 | every 6 hours | 0.001 | derived |
| 31 | New CVEs feed — NVD, with CVSS scores (last 30 days) (`nvd-recent-cves`) | feed | NIST National Vulnerability Database | Public domain (U.S. Government work) | every 6 hours | 0.005 | 3,318 |
| 32 | npm security advisories & malicious packages feed (OSV) (`osv-npm-advisories`) | feed | OSV — Open Source Vulnerabilities | CC-BY-4.0 | every 3 hours | 0.005 | 150 |
| 33 | PyPI security advisories & malicious packages feed (OSV) (`osv-pypi-advisories`) | feed | OSV — Open Source Vulnerabilities | CC-BY-4.0 | every 3 hours | 0.005 | 150 |
| 34 | Go security advisories & malicious packages feed (OSV) (`osv-go-advisories`) | feed | OSV — Open Source Vulnerabilities | CC-BY-4.0 | every 3 hours | 0.005 | 150 |
| 35 | Rust (crates.io) security advisories & malicious packages feed (OSV) (`osv-cratesio-advisories`) | feed | OSV — Open Source Vulnerabilities | CC-BY-4.0 | every 3 hours | 0.005 | 150 |
| 36 | Maven security advisories & malicious packages feed (OSV) (`osv-maven-advisories`) | feed | OSV — Open Source Vulnerabilities | CC-BY-4.0 | every 3 hours | 0.005 | 150 |
| 37 | Dependency vulnerability check — any package version (OSV, live) (`osv-package-check`) | lookup | OSV — Open Source Vulnerabilities | CC-BY-4.0 | live | 0.002 | live |
| 38 | Package intelligence — versions, licenses, advisories (deps.dev, live) (`depsdev-package`) | lookup | Open Source Insights (deps.dev) | CC-BY-4.0 | live | 0.002 | live |
| 39 | arXiv new papers digest — cs.AI Artificial Intelligence (`arxiv-cs-ai`) | feed | arXiv API (metadata) | CC0-1.0 (metadata); links point to arXiv for full text | every 12 hours | 0.003 | 200 |
| 40 | arXiv new papers digest — cs.LG Machine Learning (`arxiv-cs-lg`) | feed | arXiv API (metadata) | CC0-1.0 (metadata); links point to arXiv for full text | every 12 hours | 0.003 | 200 |
| 41 | arXiv new papers digest — cs.CL Computation and Language (NLP/LLMs) (`arxiv-cs-cl`) | feed | arXiv API (metadata) | CC0-1.0 (metadata); links point to arXiv for full text | every 12 hours | 0.003 | 200 |
| 42 | arXiv new papers digest — cs.CR Cryptography and Security (`arxiv-cs-cr`) | feed | arXiv API (metadata) | CC0-1.0 (metadata); links point to arXiv for full text | every 12 hours | 0.003 | 200 |
| 43 | arXiv new papers digest — cs.RO Robotics (`arxiv-cs-ro`) | feed | arXiv API (metadata) | CC0-1.0 (metadata); links point to arXiv for full text | every 12 hours | 0.003 | on server |
| 44 | arXiv new papers digest — q-fin.ST Statistical Finance (`arxiv-q-fin-st`) | feed | arXiv API (metadata) | CC0-1.0 (metadata); links point to arXiv for full text | every 12 hours | 0.003 | on server |
| 45 | Trending Wikipedia articles — English (daily top 100) (`wikipedia-top-en`) | feed | Wikimedia Pageviews API | CC0-1.0 (pageview data) | daily | 0.003 | ~700 |
| 46 | Trending Wikipedia articles — Spanish (daily top 100) (`wikipedia-top-es`) | feed | Wikimedia Pageviews API | CC0-1.0 (pageview data) | daily | 0.003 | ~600 |
| 47 | Trending Wikipedia articles — Catalan (daily top 100) (`wikipedia-top-ca`) | feed | Wikimedia Pageviews API | CC0-1.0 (pageview data) | daily | 0.003 | ~700 |
| 48 | Entity lookup — Wikidata ids, descriptions, Wikipedia links (live) (`wikidata-entity`) | lookup | Wikidata | CC0-1.0 | live | 0.001 | live |
| 49 | Company LEI lookup — legal name, jurisdiction, status (GLEIF, live) (`gleif-lei`) | lookup | GLEIF — Global Legal Entity Identifier Foundation | CC0-1.0 | live | 0.002 | live |
| 50 | Earthquakes feed — M2.5+ worldwide, last 30 days (USGS) (`usgs-earthquakes`) | feed | USGS Earthquake Hazards Program | Public domain (U.S. Government work) | hourly | 0.003 | 1,836 |
| 51 | Open natural events — wildfires, storms, volcanoes, floods (NASA EONET) (`eonet-natural-events`) | feed | NASA EONET (Earth Observatory Natural Event Tracker) | Public domain (NASA data) | every 6 hours | 0.003 | 175 |
| 52 | Weather forecasts for 60 world cities — hourly, next 72 h (MET Norway) (`city-weather-forecasts`) | dataset | MET Norway Locationforecast | CC-BY-4.0 / NLOD 2.0 | every 6 hours | 0.01 | 3,980 |
| 53 | Weather forecast for any coordinates — hourly, next 48 h (MET Norway, live) (`weather-forecast`) | lookup | MET Norway Locationforecast | CC-BY-4.0 / NLOD 2.0 | live | 0.002 | live |
| 54 | Solana priority-fee & throughput stats — hourly snapshots (`solana-priority-fees`) | feed | Solana mainnet public RPC | Public on-chain data (facts; no license restriction) | hourly | 0.002 | on server |
| 55 | Base (L2) gas price stats — hourly snapshots (`base-gas`) | feed | Base mainnet public RPC | Public on-chain data (facts; no license restriction) | hourly | 0.002 | 1/h |

- **"derived" lookups** answer from the dataset they belong to: fx-convert from fx-history,
  city-lookup from world-cities, airport-lookup from airports, country-economy-snapshot
  from the World Bank datasets, and kev-check from cisa-kev.
- **"live" lookups** call the official API for each query, with a timeout. The buyer is
  refunded on failure.
- **"on server"** marks a product that could not be measured from the build box because
  the upstream rate-limited it. It is collected on the server.

## Source policy

- **Licenses allowed:** only sources whose license or terms allow commercial reuse and
  redistribution: CC0, CC-BY (attribution is carried on every delivery), public-domain
  government works, OGL v3, NLOD, and the ECB/INE reuse policies. Each product records the
  license, its URL and the attribution text.
- **No personal data:** for example, SEC Form 4 insider filings are excluded.
- **Polite fetching:**
  - All requests identify themselves with
    `User-Agent: RosterNetworkData/1.0 (+https://roster.network; data@roster.network)`.
  - Fetching is sequential, with one retry after 3 s (none on 4xx other than 429).
  - Per-source pacing:
    - NVD: 7 s between pages.
    - arXiv: 6 s between requests, 45 s backoff on 429.
    - SEC EDGAR: under the fair-access limit of 10 req/s.
    - MET Norway: about 60 locations every 6 h.
  - Only official APIs and bulk files are used, never HTML scraping, so robots.txt is
    respected.

## Skipped sources and why

| Source | Reason |
|---|---|
| Nager.Date (public holidays) | Commercial use requires sponsorship. GOV.UK holidays are used instead. |
| date-holidays (npm) | CC-BY-SA share-alike: resale would force the same license downstream. |
| FIRST EPSS | Redistribution terms are unclear. |
| OpenAlex | The API now requires a key or paid plan for bulk access. |
| GitHub REST API (repo trends) | The ToS restricts reselling API data, and the rate limits are tight. |
| Open-Meteo | The free tier is non-commercial only. MET Norway (CC-BY/NLOD) is used instead. |
| npm / PyPI / crates.io registry metadata | The terms for redistributing bulk metadata are unclear. deps.dev (CC-BY-4.0) is used instead. |
| CoinGecko, token lists | The ToS forbids redistribution and resale. |
| Hacker News API | No license is stated. |
| Nominatim / OpenStreetMap, Open Food Facts | ODbL share-alike. |
| EU VAT rates | No official machine-readable feed with clear reuse terms. Not shipped. Logged as demand. |
| FRED | Requires an API key, and its terms restrict third-party series. |
| SEC Form 4 (insider trades) | Personal data about individuals. |
