import { NextRequest, NextResponse } from "next/server";

const CH_CREATE_API = "https://oberlin.communityhub.cloud/api/legacy/calendar/post/submit";

export async function POST(req: NextRequest) {
  const { payload } = await req.json();

  // Pull out the internal helper field and map to the API's image_cdn_url field.
  // The CommunityHub API accepts image URLs directly — no base64 conversion needed.
  const photoUrl: string | null = payload._photoUrl ?? null;
  delete payload._photoUrl;

  if (photoUrl) {
    payload.image_cdn_url = photoUrl;
  }

  // Always submit under the project email
  payload.email = "fkusiapp@oberlin.edu";

  const res = await fetch(CH_CREATE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `CommunityHub ${res.status}: ${text}` },
      { status: 502 }
    );
  }

  return NextResponse.json(await res.json());
}
