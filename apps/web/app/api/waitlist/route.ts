import { NextResponse } from "next/server";
import { resolveRosterApiOrigin, rosterProxyTarget } from "@/lib/api-base";
import { forwardClientAddress } from "@/lib/admin-session";
import { parseWaitlist } from "@/lib/waitlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_CHARS = 2048;

export async function POST(request: Request) {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const parsed = parseWaitlist(body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  forwardClientAddress(request.headers, headers);
  let upstream: Response;
  try {
    upstream = await fetch(rosterProxyTarget(resolveRosterApiOrigin(), ["v1", "waitlist"], ""), {
      method: "POST",
      headers,
      body: JSON.stringify({ email: parsed.email, source: `landing:${parsed.role}` }),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 502 });
  }
  if (upstream.status === 429) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "retry-after": upstream.headers.get("retry-after") ?? "60" } },
    );
  }
  if (upstream.status === 400) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
