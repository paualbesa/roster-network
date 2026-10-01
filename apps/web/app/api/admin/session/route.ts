import { NextResponse } from "next/server";
import { resolveRosterApiOrigin, rosterProxyTarget } from "@/lib/api-base";
import {
  ADMIN_COOKIE_MAX_AGE,
  ADMIN_COOKIE_NAME,
  parseAdminTokenInput,
  readAdminCookie,
  requestIsSecure,
} from "@/lib/admin-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_CHARS = 2048;

export async function GET(request: Request) {
  const token = readAdminCookie(request.headers.get("cookie"));
  return NextResponse.json({ signedIn: Boolean(token) });
}

export async function DELETE(request: Request) {
  const response = NextResponse.json({ ok: true });
  clearCookie(response, request);
  return response;
}

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
  const tokenField =
    typeof body === "object" && body !== null && "token" in body ? (body as { token: unknown }).token : undefined;
  const parsed = parseAdminTokenInput(tokenField);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 400 });
  }

  let upstream: Response;
  try {
    const target = rosterProxyTarget(resolveRosterApiOrigin(), ["v1", "admin", "overview"], "");
    upstream = await fetch(target, {
      method: "GET",
      headers: { accept: "application/json", "x-roster-admin-token": parsed.token },
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "unavailable", message: "Roster API is unreachable from this site." },
      { status: 502 },
    );
  }

  if (upstream.status === 401) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", message: "That operator token was rejected." },
      { status: 401 },
    );
  }
  if (upstream.status === 503) {
    return NextResponse.json(
      { ok: false, error: "admin_disabled", message: "The admin API is disabled. Set ROSTER_ADMIN_TOKEN on the API." },
      { status: 503 },
    );
  }
  if (!upstream.ok || upstream.status >= 300) {
    return NextResponse.json(
      { ok: false, error: "unavailable", message: "Roster API could not check the operator token." },
      { status: 502 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: parsed.token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE,
    secure: requestIsSecure(request.url, request.headers.get("x-forwarded-proto")),
  });
  return response;
}

function clearCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: requestIsSecure(request.url, request.headers.get("x-forwarded-proto")),
  });
}
