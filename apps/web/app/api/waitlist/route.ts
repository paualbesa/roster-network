import { NextResponse } from "next/server";
import { parseWaitlist } from "@/lib/waitlist";

const MAX_BODY_CHARS = 2048;

/** Sandbox stub. Validates a waitlist payload and stores nothing. */
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

  return NextResponse.json({ ok: true });
}
