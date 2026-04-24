import fs from "fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initFirebase() {
  if (getApps().length > 0) return getFirestore();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const serviceAccount = JSON.parse(raw);
    initializeApp({ credential: cert(serviceAccount) });
    return getFirestore();
  } catch {
    console.warn("Could not init Firebase — stats will not be saved.");
    return null;
  }
}

const LOCALIST_API = "https://calendar.oberlin.edu/api/2/events";
const COMMUNITYHUB_API = "https://oberlin.communityhub.cloud/api/legacy/calendar/post/submit";
const PUSHED_IDS_FILE = "pushed_ids.json";
const FALLBACK_EMAIL = process.env.FALLBACK_EMAIL || "frankkusiap@gmail.com";

const POST_TYPE_MAP = {
  "lecture":          6,
  "talk":             6,
  "presentation":     6,
  "seminar":          6,
  "symposium":        6,
  "conference":       6,
  "music":            8,
  "concert":          8,
  "performance":      9,
  "theatre":          9,
  "theater":          9,
  "dance":            9,
  "workshop":         7,
  "class":            7,
  "exhibit":          2,
  "exhibition":       2,
  "gallery":          2,
  "festival":         3,
  "fair":             3,
  "celebration":      3,
  "tour":             4,
  "open house":       4,
  "sport":           12,
  "game":            12,
  "recreation":      12,
  "networking":      13,
};

function mapPostTypeIds(eventTypes = []) {
  const ids = new Set();
  for (const et of eventTypes) {
    const lower = et.name.toLowerCase();
    let matched = false;
    for (const [keyword, id] of Object.entries(POST_TYPE_MAP)) {
      if (lower.includes(keyword)) {
        ids.add(id);
        matched = true;
        break;
      }
    }
    if (!matched) ids.add(89);
  }
  return ids.size > 0 ? [...ids] : [89];
}

function mapLocationType(experience) {
  if (experience === "virtual") return "on";
  if (experience === "hybrid") return "bo";
  return "ph2";
}

function toUnix(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

function stripUrls(str) {
  if (!str) return "";
  return str
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(streaming video|watch (the )?webcast|live stream|stream link|video link)\s*[:\-]?\s*/gi, "")
    .split("\n").map(l => l.trim()).filter(l => l.length > 0).join(" ")
    .replace(/\s{2,}/g, " ").trim();
}

function truncateAtSentence(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  const chunk = str.slice(0, max);
  const lastPeriod = chunk.lastIndexOf(".");
  if (lastPeriod > max * 0.5) return str.slice(0, lastPeriod + 1).trim();
  return chunk.trimEnd();
}

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

async function buildPayload(e) {
  const inst = e.event_instances?.[0]?.event_instance || {};
  const startTime = inst.start ? toUnix(inst.start) : toUnix(new Date().toISOString());
  const endTime = inst.end ? toUnix(inst.end) : startTime + 3600;
  const experience = e.experience || "inperson";
  const locationType = mapLocationType(experience);
  const eventTypes = e.filters?.event_types || [];
  const departments = e.filters?.departments || [];
  const sponsors = departments.map((d) => d.name);
  if (sponsors.length === 0) sponsors.push("Oberlin College");

  const rawDescription = stripUrls((e.description_text || e.description || "").replace(/<[^>]*>/g, " ").trim());
  const description = truncateAtSentence(rawDescription, 200) || "No description provided.";
  const extendedDescription = truncateAtSentence(rawDescription, 1000);
  const title = truncateAtSentence(e.title || "Untitled Event", 60);
  const contactEmail = e.custom_fields?.contact_email_address || FALLBACK_EMAIL;
  const phone = e.custom_fields?.contact_phone_number || undefined;
  const website = e.localist_url || e.url || undefined;
  const location = e.address || e.location_name || e.location || undefined;
  const streamUrl = e.stream_url || undefined;
  const imageBase64 = e.photo_url ? await fetchImageAsBase64(e.photo_url) : null;

  const payload = {
    eventType: "ot",
    email: contactEmail,
    subscribe: true,
    contactEmail,
    title,
    sponsors,
    postTypeId: mapPostTypeIds(eventTypes),
    sessions: [{ startTime, endTime }],
    description,
    extendedDescription,
    locationType,
    display: "all",
    screensIds: [],
    public: "1",
  };

  payload.phone = phone || "";
  if (website) payload.website = website;

  if (locationType === "ph2" || locationType === "bo") {
    payload.location = location || "Oberlin, OH";
    payload.placeId = "";
    payload.placeName = "";
  }
  if (locationType === "on" || locationType === "bo") {
    payload.urlLink = streamUrl || website || "https://calendar.oberlin.edu";
  }

  if (imageBase64) payload.image = imageBase64;

  if (e.ticket_url) {
    payload.buttons = [{ title: "Learn More", link: e.ticket_url }];
  }

  return payload;
}

async function fetchLocalist(days = 365, pp = 100, maxPages = 10) {
  let page = 1;
  let totalPages = 1;
  const events = [];

  while (page <= totalPages && page <= maxPages) {
    const url = new URL(LOCALIST_API);
    url.searchParams.set("days", String(days));
    url.searchParams.set("pp", String(pp));
    url.searchParams.set("page", String(page));

    const res = await fetch(url, { headers: { "User-Agent": "localist-sync-bot/1.0" } });
    if (!res.ok) throw new Error(`Localist HTTP ${res.status}`);

    const payload = await res.json();
    const items = payload.events || [];
    const total = Number(payload.page?.total || items.length || 0);
    totalPages = Math.max(1, Math.ceil(total / pp));

    for (const wrapped of items) {
      const e = wrapped.event;
      if (!e || e.status !== "live" || e.private) continue;
      events.push(e);
    }

    page += 1;
  }

  return events;
}

async function pushToCommunityHub(payload) {
  const res = await fetch(COMMUNITYHUB_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CommunityHub HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

function loadPushedIds() {
  if (!fs.existsSync(PUSHED_IDS_FILE)) return new Set();
  const raw = fs.readFileSync(PUSHED_IDS_FILE, "utf8");
  return new Set(JSON.parse(raw));
}

function savePushedIds(ids) {
  fs.writeFileSync(PUSHED_IDS_FILE, JSON.stringify([...ids], null, 2));
}

async function main() {
  const pushedIds = loadPushedIds();
  console.log(`Loaded ${pushedIds.size} already-pushed IDs`);

  const events = await fetchLocalist();
  console.log(`Fetched ${events.length} live public events from Localist`);

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  const failedEvents = [];

  for (const e of events) {
    const id = String(e.id);

    if (pushedIds.has(id)) {
      skipped++;
      continue;
    }

    try {
      const payload = await buildPayload(e);
      await pushToCommunityHub(payload);
      pushedIds.add(id);
      pushed++;
      console.log(`✓ Pushed: ${e.title}`);
    } catch (err) {
      failed++;
      failedEvents.push({ title: e.title || "Untitled", reason: err.message });
      console.error(`✗ Failed: ${e.title} — ${err.message}`);
    }
  }

  savePushedIds(pushedIds);
  console.log(`Done — pushed: ${pushed}, skipped: ${skipped}, failed: ${failed}`);

  const db = initFirebase();
  if (db) {
    await db.collection("syncs").doc("localist").set({
      source: "Oberlin Localist",
      pushed,
      skipped,
      skippedReason: "Already pushed in a previous run",
      failed,
      failedEvents,
      total: pushedIds.size,
      lastRun: new Date().toISOString(),
    });
    console.log("Stats saved to Firestore.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
