import { SOURCES } from "../sources.js";
import type { DataFetchContext, DataProductSpec, Row } from "../types.js";
import { numberOrNull, round, textOrNull } from "../util.js";


/** 60 major cities for the forecast table. Coordinates rounded to 4 decimals (MET Norway terms). */
const FORECAST_CITIES: [string, string, number, number][] = [
  ["Barcelona", "ES", 41.3888, 2.159], ["Madrid", "ES", 40.4165, -3.7026], ["Valencia", "ES", 39.4699, -0.3763],
  ["Sevilla", "ES", 37.3886, -5.9823], ["Bilbao", "ES", 43.263, -2.935], ["Palma", "ES", 39.5696, 2.6502],
  ["Lisbon", "PT", 38.7167, -9.1333], ["Paris", "FR", 48.8534, 2.3488], ["Marseille", "FR", 43.2965, 5.3698],
  ["London", "GB", 51.5085, -0.1257], ["Manchester", "GB", 53.4809, -2.2374], ["Dublin", "IE", 53.3331, -6.2489],
  ["Amsterdam", "NL", 52.374, 4.8897], ["Brussels", "BE", 50.8505, 4.3488], ["Berlin", "DE", 52.5244, 13.4105],
  ["Munich", "DE", 48.1374, 11.5755], ["Frankfurt", "DE", 50.1155, 8.6842], ["Zurich", "CH", 47.3667, 8.55],
  ["Vienna", "AT", 48.2085, 16.3721], ["Milan", "IT", 45.4643, 9.1895], ["Rome", "IT", 41.8919, 12.5113],
  ["Athens", "GR", 37.9838, 23.7278], ["Warsaw", "PL", 52.2298, 21.0118], ["Prague", "CZ", 50.088, 14.4208],
  ["Budapest", "HU", 47.498, 19.0399], ["Copenhagen", "DK", 55.6759, 12.5655], ["Stockholm", "SE", 59.3294, 18.0687],
  ["Oslo", "NO", 59.9127, 10.7461], ["Helsinki", "FI", 60.1695, 24.9354], ["Istanbul", "TR", 41.0138, 28.9497],
  ["New York", "US", 40.7143, -74.006], ["Los Angeles", "US", 34.0522, -118.2437], ["Chicago", "US", 41.85, -87.65],
  ["San Francisco", "US", 37.7749, -122.4194], ["Miami", "US", 25.7743, -80.1937], ["Toronto", "CA", 43.7001, -79.4163],
  ["Mexico City", "MX", 19.4285, -99.1277], ["São Paulo", "BR", -23.5475, -46.6361], ["Buenos Aires", "AR", -34.6132, -58.3772],
  ["Bogotá", "CO", 4.6097, -74.0817], ["Lima", "PE", -12.0432, -77.0282], ["Santiago", "CL", -33.4569, -70.6483],
  ["Cairo", "EG", 30.0626, 31.2497], ["Lagos", "NG", 6.4541, 3.3947], ["Nairobi", "KE", -1.2833, 36.8167],
  ["Johannesburg", "ZA", -26.2023, 28.0436], ["Casablanca", "MA", 33.5883, -7.6114], ["Dubai", "AE", 25.0772, 55.3093],
  ["Riyadh", "SA", 24.6877, 46.7219], ["Mumbai", "IN", 19.0728, 72.8826], ["Delhi", "IN", 28.6519, 77.2315],
  ["Bangalore", "IN", 12.9719, 77.5937], ["Singapore", "SG", 1.2897, 103.8501], ["Bangkok", "TH", 13.754, 100.5014],
  ["Jakarta", "ID", -6.2146, 106.8451], ["Hong Kong", "HK", 22.2783, 114.1747], ["Shanghai", "CN", 31.2222, 121.4581],
  ["Tokyo", "JP", 35.6895, 139.6917], ["Seoul", "KR", 37.566, 126.9784], ["Sydney", "AU", -33.8678, 151.2073],
];

interface MetForecast {
  properties: {
    timeseries: {
      time: string;
      data: {
        instant: { details: Record<string, number> };
        next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
        next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
      };
    }[];
  };
}

function forecastRows(city: string, country: string, lat: number, lon: number, data: MetForecast, hours: number, now: Date): Row[] {
  const until = now.getTime() + hours * 3600_000;
  return data.properties.timeseries
    .filter((step) => Date.parse(step.time) <= until && Date.parse(step.time) >= now.getTime() - 3600_000)
    .map((step) => {
      const details = step.data.instant.details;
      const next = step.data.next_1_hours ?? step.data.next_6_hours;
      return {
        id: `${city}:${step.time}`,
        city,
        country,
        latitude: lat,
        longitude: lon,
        time: step.time,
        temperature_c: numberOrNull(details.air_temperature),
        precipitation_mm: numberOrNull(next?.details?.precipitation_amount ?? null),
        wind_speed_ms: numberOrNull(details.wind_speed),
        wind_from_deg: numberOrNull(details.wind_from_direction),
        humidity_pct: numberOrNull(details.relative_humidity),
        cloud_cover_pct: numberOrNull(details.cloud_area_fraction),
        pressure_hpa: numberOrNull(details.air_pressure_at_sea_level),
        symbol: textOrNull(next?.summary?.symbol_code ?? null),
      };
    });
}

async function metForecast(ctx: DataFetchContext, lat: number, lon: number, timeoutMs = 20_000): Promise<MetForecast> {
  return ctx.fetchJson<MetForecast>(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${round(lat, 4)?.toString() ?? "0"}&lon=${round(lon, 4)?.toString() ?? "0"}`,
    { timeoutMs },
  );
}

const FORECAST_COLUMNS: DataProductSpec["columns"] = [
  { name: "city", type: "string", description: "City (or 'custom' for coordinates)." },
  { name: "country", type: "string", description: "ISO alpha-2." },
  { name: "latitude", type: "number", description: "Latitude." },
  { name: "longitude", type: "number", description: "Longitude." },
  { name: "time", type: "datetime", description: "Forecast time (UTC)." },
  { name: "temperature_c", type: "number", description: "Air temperature, °C." },
  { name: "precipitation_mm", type: "number", description: "Precipitation in the next hour (or 6 h), mm." },
  { name: "wind_speed_ms", type: "number", description: "Wind speed, m/s." },
  { name: "wind_from_deg", type: "number", description: "Wind direction, degrees." },
  { name: "humidity_pct", type: "number", description: "Relative humidity, %." },
  { name: "cloud_cover_pct", type: "number", description: "Cloud cover, %." },
  { name: "pressure_hpa", type: "number", description: "Sea-level pressure, hPa." },
  { name: "symbol", type: "string", description: "Weather symbol (clearsky_day, rain…)." },
];

export const environmentProducts: DataProductSpec[] = [
  {
    slug: "usgs-earthquakes",
    name: "Earthquakes feed — M2.5+ worldwide, last 30 days (USGS)",
    kind: "feed",
    description:
      "Every magnitude 2.5+ earthquake worldwide from the USGS, rolling 30 days: time, magnitude, depth, coordinates, place, tsunami flag, felt reports and alert level. Hourly refresh. Filter by alert level or poll since a timestamp.",
    tags: ["earthquakes", "seismic", "usgs", "natural-hazards", "geology", "disasters", "feed", "risk"],
    sources: [SOURCES.usgs],
    cadence: "hourly",
    intervalS: 3600,
    priceUsdc: "0.01",
    p95Ms: 4000,
    timeField: "time",
    idField: "id",
    retainDays: 30,
    maxRows: 20_000,
    filterFields: ["alert", "tsunami"],
    columns: [
      { name: "id", type: "string", description: "USGS event id." },
      { name: "time", type: "datetime", description: "Origin time (UTC)." },
      { name: "magnitude", type: "number", description: "Magnitude." },
      { name: "mag_type", type: "string", description: "Magnitude type." },
      { name: "place", type: "string", description: "Region description." },
      { name: "latitude", type: "number", description: "Latitude." },
      { name: "longitude", type: "number", description: "Longitude." },
      { name: "depth_km", type: "number", description: "Depth, km." },
      { name: "tsunami", type: "boolean", description: "Tsunami flag." },
      { name: "felt", type: "integer", description: "Felt reports." },
      { name: "alert", type: "string", description: "PAGER alert (green…red)." },
      { name: "url", type: "string", description: "USGS event page." },
    ],
    ingest: async (ctx, previous) => {
      const feed = previous.length > 0 ? "2.5_week" : "2.5_month";
      const data = await ctx.fetchJson<{
        features: {
          id: string;
          properties: { mag: number | null; magType: string; place: string; time: number; tsunami: number; felt: number | null; alert: string | null; url: string };
          geometry: { coordinates: [number, number, number] };
        }[];
      }>(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`);
      return data.features.map((feature) => ({
        id: feature.id,
        time: new Date(feature.properties.time).toISOString(),
        magnitude: numberOrNull(feature.properties.mag),
        mag_type: textOrNull(feature.properties.magType),
        place: textOrNull(feature.properties.place),
        latitude: numberOrNull(feature.geometry.coordinates[1]),
        longitude: numberOrNull(feature.geometry.coordinates[0]),
        depth_km: numberOrNull(feature.geometry.coordinates[2]),
        tsunami: feature.properties.tsunami === 1,
        felt: numberOrNull(feature.properties.felt),
        alert: textOrNull(feature.properties.alert),
        url: feature.properties.url,
      }));
    },
  },
  {
    slug: "eonet-natural-events",
    name: "Open natural events — wildfires, storms, volcanoes, floods (NASA EONET)",
    kind: "feed",
    description:
      "Currently open natural events tracked by NASA EONET: wildfires, severe storms, volcanoes, floods, sea and lake ice, with category, latest position and magnitude, and source links. Refreshed every 6 hours.",
    tags: ["natural-disasters", "wildfires", "storms", "volcanoes", "nasa", "eonet", "climate", "feed", "risk"],
    sources: [SOURCES.eonet],
    cadence: "every 6 hours",
    intervalS: 6 * 3600,
    priceUsdc: "0.01",
    p95Ms: 4000,
    timeField: "last_seen_at",
    idField: "id",
    retainDays: 60,
    maxRows: 5000,
    filterFields: ["category"],
    columns: [
      { name: "id", type: "string", description: "EONET id." },
      { name: "title", type: "string", description: "Event title." },
      { name: "category", type: "string", description: "Category id (wildfires, severeStorms…)." },
      { name: "last_seen_at", type: "datetime", description: "Latest observation time." },
      { name: "latitude", type: "number", description: "Latest latitude." },
      { name: "longitude", type: "number", description: "Latest longitude." },
      { name: "magnitude", type: "number", description: "Latest magnitude value." },
      { name: "magnitude_unit", type: "string", description: "Unit (acres, kts…)." },
      { name: "sources", type: "string", description: "Source URLs." },
      { name: "url", type: "string", description: "EONET API link." },
    ],
    ingest: async (ctx) => {
      const data = await ctx.fetchJson<{
        events: {
          id: string;
          title: string;
          link: string;
          categories: { id: string }[];
          sources: { url: string }[];
          geometry: { date: string; type: string; coordinates: unknown; magnitudeValue?: number | null; magnitudeUnit?: string | null }[];
        }[];
      }>("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=60");
      return data.events.map((event) => {
        const last = [...event.geometry].sort((left, right) => right.date.localeCompare(left.date))[0];
        const point = last?.type === "Point" && Array.isArray(last.coordinates) ? (last.coordinates as number[]) : null;
        return {
          id: event.id,
          title: textOrNull(event.title),
          category: event.categories.map((category) => category.id).join(";") || null,
          last_seen_at: last?.date ?? null,
          latitude: numberOrNull(point?.[1] ?? null),
          longitude: numberOrNull(point?.[0] ?? null),
          magnitude: numberOrNull(last?.magnitudeValue ?? null),
          magnitude_unit: textOrNull(last?.magnitudeUnit ?? null),
          sources: event.sources.map((source) => source.url).join(" ") || null,
          url: event.link,
        };
      });
    },
  },
  {
    slug: "city-weather-forecasts",
    name: "Weather forecasts for 60 world cities — hourly, next 72 h (MET Norway)",
    kind: "dataset",
    description:
      "Hourly forecasts for the next 72 hours for 60 major cities (Europe, Americas, Asia, Africa, Oceania): temperature, precipitation, wind, humidity, cloud cover, pressure and weather symbol, from MET Norway's model. Refreshed every 6 hours.",
    tags: ["weather", "forecast", "temperature", "precipitation", "cities", "met-norway", "climate", "travel"],
    sources: [SOURCES.metNorway],
    cadence: "every 6 hours",
    intervalS: 6 * 3600,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: FORECAST_COLUMNS,
    ingest: async (ctx) => {
      const rows: Row[] = [];
      const now = ctx.now();
      for (const [city, country, lat, lon] of FORECAST_CITIES) {
        try {
          rows.push(...forecastRows(city, country, lat, lon, await metForecast(ctx, lat, lon), 72, now).map(({ id: _id, ...row }) => row));
        } catch {
          // Skip one city rather than fail the table.
        }
        await ctx.sleep(250);
      }
      if (rows.length === 0) throw new Error("MET Norway returned no forecasts.");
      return rows;
    },
  },
  {
    slug: "weather-forecast",
    name: "Weather forecast for any coordinates — hourly, next 48 h (MET Norway, live)",
    kind: "lookup",
    description:
      "Hourly weather forecast for any latitude/longitude for the next 48 hours: temperature, precipitation, wind, humidity, clouds and symbol. Live MET Norway query (cached upstream), for travel, logistics and event agents.",
    tags: ["weather", "forecast", "coordinates", "met-norway", "lookup", "logistics"],
    sources: [SOURCES.metNorway],
    cadence: "live",
    intervalS: 3600,
    priceUsdc: "0.01",
    p95Ms: 8000,
    live: true,
    columns: FORECAST_COLUMNS,
    input: {
      latitude: { type: "number" },
      longitude: { type: "number" },
      hours: { type: "integer", description: "1-48, default 24." },
    },
    required: ["latitude", "longitude"],
    example: { latitude: 41.3888, longitude: 2.159, hours: 12 },
    lookup: async (input, ctx) => {
      const lat = numberOrNull(input.latitude);
      const lon = numberOrNull(input.longitude);
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
      const hoursRaw = numberOrNull(input.hours) ?? 24;
      const hours = Math.min(48, Math.max(1, Math.trunc(hoursRaw)));
      const data = await metForecast(ctx, lat, lon, 7000);
      return forecastRows("custom", "", round(lat, 4) ?? lat, round(lon, 4) ?? lon, data, hours, ctx.now()).map(
        ({ id: _id, ...row }) => row,
      );
    },
  },
];
