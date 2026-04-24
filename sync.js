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
const COMMUNITYHUB_POSTS_API =
  "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?limit=10000&page=0&filter=future&tab=main-feed&isJobs=false&order=ASC&postType=All&allPosts";
const PUSHED_IDS_FILE = "pushed_ids.json";
const FALLBACK_EMAIL = process.env.FALLBACK_EMAIL || "fkusiapp@oberlin.edu";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

const POST_TYPE_MAP = {
  "lecture": 6, "talk": 6, "presentation": 6, "seminar": 6,
  "symposium": 6, "conference": 6, "music": 8, "concert": 8,
  "performance": 9, "theatre": 9, "theater": 9, "dance": 9,
  "workshop": 7, "class": 7, "exhibit": 2, "exhibition": 2,
  "gallery": 2, "festival": 3, "fair": 3, "celebration": 3,
  "tour": 4, "open house": 4, "sport": 12, "game": 12,
  "recreation": 12, "networking": 13,
};

function mapPostTypeIds(eventTypes = []) {
  const ids = new Set();
  for (const et of eventTypes) {
    const lower = et.name.toLowerCase();
    let matched = false;
    for (const [keyword, id] of Object.entries(POST_TYPE_MAP)) {
      if (lower.includes(keyword)) { ids.add(id); matched = true; break; }
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

// ─── Fallback description cleaning (used when Gemini unavailable) ───────────

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

// ─── Gemini helpers ──────────────────────────────────────────────────────────

async function geminiCall(prompt) {
  if (!GEMINI_API_KEY) return null;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// Writer Agent: remove URLs and summarize
async function geminiClean(rawText, maxChars) {
  if (!GEMINI_API_KEY || !rawText) return null;
  try {
    return await geminiCall(`You are cleaning an event description for a community calendar.

Instructions:
- Remove ALL URLs (http/https links)
- Remove streaming video references ("Streaming Video:", "Watch the webcast", "Live stream:", "Stream link:", "Video link:")
- Summarize the result to under ${maxChars} characters
- End at a complete sentence boundary (do not cut mid-sentence)
- If the text is already clean and short enough, return it as-is
- Return ONLY the cleaned text — no quotes, no explanation

Description to clean:
"""
${rawText}
"""`);
  } catch (err) {
    console.warn(`Writer Agent failed: ${err.message} — using fallback`);
    return null;
  }
}

// Duplicate Agent: Gemini confirms a pre-filtered candidate pair
async function geminiCheckDuplicate(incoming, existing) {
  if (!GEMINI_API_KEY) return null;
  try {
    const raw = await geminiCall(`You are a duplicate detection agent for a community calendar.

Determine if these two events are the SAME real-world event (possibly posted from different sources or with slightly different wording).

Incoming event (about to be posted):
- Title: ${incoming.title}
- Date: ${incoming.date}
- Location: ${incoming.location}
- Description: ${(incoming.description || "").slice(0, 300)}

Existing event (already on CommunityHub):
- Title: ${existing.title}
- Date: ${existing.date}
- Location: ${existing.location}

Reply with a JSON object only — no markdown:
{"isDuplicate": true, "confidence": 0-100, "reason": "one sentence"}`);
    return JSON.parse((raw || "{}").replace(/```json\n?|```/g, "").trim());
  } catch (err) {
    console.warn(`Duplicate Agent failed: ${err.message}`);
    return null;
  }
}

// Public Agent: is this event open to the general public?
async function geminiCheckPublic(e) {
  if (!GEMINI_API_KEY) return { isPublic: true, confidence: 50, reason: "Gemini unavailable — defaulted to public" };
  const title = e.title || "";
  const desc = (e.description_text || e.description || "").replace(/<[^>]*>/g, " ").trim().slice(0, 600);
  try {
    const raw = await geminiCall(`You are a public-access filter agent for a community calendar serving the town of Oberlin, Ohio.

The ONLY question: Can a regular Oberlin town resident — someone with ZERO Oberlin College affiliation — walk in and attend this event?

PRIVATE (reject) if ANY of these apply:
- Requires being an Oberlin College student, faculty, staff, or affiliate
- Academic deadlines, grading policies, advising, tutoring, registration
- Department/faculty/staff meetings
- Student org meetings (OSCA, co-ops, student senate, etc.)
- Requires college login, ID card, or enrollment to register or attend
- Described as exclusive to a school or institution group
- Career/recruiting events restricted to enrolled students

PUBLIC (approve) only if a non-affiliated town resident can genuinely attend:
- Open to the Oberlin community or general public with no affiliation required
- Public lectures, performances, concerts, exhibitions, open houses, festivals
- Community events where anyone can walk in

When in doubt, mark PRIVATE. It is better to be too cautious than to post internal school events on a public community calendar.

Event:
- Title: ${title}
- Description: ${desc}

Reply with JSON only — no markdown:
{"isPublic": true, "confidence": 0-100, "reason": "one sentence"}`);
    return JSON.parse((raw || "{}").replace(/```json\n?|```/g, "").trim());
  } catch (err) {
    console.warn(`Public Agent failed: ${err.message} — defaulting to public`);
    return { isPublic: true, confidence: 50, reason: "Could not determine — defaulted to public" };
  }
}

// Pre-filter: same date AND (title word overlap OR location word overlap)
function mightBeDuplicate(incoming, chEvent) {
  if (!incoming.date || !chEvent.date) return false;
  if (incoming.date !== chEvent.date) return false;

  // Title overlap is the strongest signal
  const inTitle = new Set(incoming.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const chTitleWords = (chEvent.title || "").toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (chTitleWords.some(w => inTitle.has(w))) return true;

  // Fall back to location overlap
  const a = (incoming.location || "").toLowerCase();
  const b = (chEvent.location || "").toLowerCase();
  if (!a || !b) return true;
  const aWords = new Set(a.split(/\W+/).filter(w => w.length > 3));
  return b.split(/\W+/).filter(w => w.length > 3).some(w => aWords.has(w));
}

// ─── Data fetching ───────────────────────────────────────────────────────────

async function fetchCommunityHubEvents() {
  try {
    const res = await fetch(COMMUNITYHUB_POSTS_API, {
      headers: { "User-Agent": "localist-sync-bot/1.0" },
    });
    if (!res.ok) throw new Error(`CommunityHub posts HTTP ${res.status}`);
    const data = await res.json();
    return (data.posts || []).map(p => ({
      id: p.id,
      title: p.name || "",
      date: p.sessions?.[0]?.start
        ? new Date(p.sessions[0].start * 1000).toISOString().slice(0, 10)
        : "",
      location: p.location?.name || p.location?.address || "",
      description: p.description || "",
    }));
  } catch (err) {
    console.warn(`Could not fetch CommunityHub events: ${err.message}`);
    return [];
  }
}

async function fetchLocalist(days = 365, pp = 100, maxPages = 10) {
  let page = 1, totalPages = 1;
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
    page++;
  }
  return events;
}

// Load all IDs already in the review_queue or rejected collections (any status)
async function loadProcessedIds(db) {
  if (!db) return new Set();
  try {
    const [queueSnap, rejectedSnap] = await Promise.all([
      db.collection("review_queue").select().get(),
      db.collection("rejected").select().get(),
    ]);
    return new Set([
      ...queueSnap.docs.map(d => d.id),
      ...rejectedSnap.docs.map(d => d.id),
    ]);
  } catch {
    return new Set();
  }
}

function loadPushedIds() {
  if (!fs.existsSync(PUSHED_IDS_FILE)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(PUSHED_IDS_FILE, "utf8")));
}

function savePushedIds(ids) {
  fs.writeFileSync(PUSHED_IDS_FILE, JSON.stringify([...ids], null, 2));
}

// ─── Payload builder (Writer Agent output) ───────────────────────────────────

async function buildWriterPayload(e) {
  const inst = e.event_instances?.[0]?.event_instance || {};
  const startTime = inst.start ? toUnix(inst.start) : toUnix(new Date().toISOString());
  const endTime = inst.end ? toUnix(inst.end) : startTime + 3600;
  const experience = e.experience || "inperson";
  const locationType = mapLocationType(experience);
  const departments = e.filters?.departments || [];
  const sponsors = departments.map(d => d.name);
  if (sponsors.length === 0) sponsors.push("Oberlin College");

  const rawDescription = (e.description_text || e.description || "").replace(/<[^>]*>/g, " ").trim();

  let description = await geminiClean(rawDescription, 200);
  let extendedDescription = await geminiClean(rawDescription, 1000);

  if (!description) {
    const cleaned = stripUrls(rawDescription);
    description = truncateAtSentence(cleaned, 200) || "No description provided.";
    extendedDescription = truncateAtSentence(cleaned, 1000);
  }
  description = description || "No description provided.";
  extendedDescription = extendedDescription || description;

  const contactEmail = e.custom_fields?.contact_email_address || FALLBACK_EMAIL;
  const location = e.address || e.location_name || e.location || "Oberlin, OH";
  const streamUrl = e.stream_url || undefined;
  const website = e.localist_url || e.url || undefined;

  const payload = {
    eventType: "ot",
    email: contactEmail,
    subscribe: true,
    contactEmail,
    title: (e.title || "Untitled Event").slice(0, 60),
    sponsors,
    postTypeId: mapPostTypeIds(e.filters?.event_types || []),
    sessions: [{ startTime, endTime }],
    description,
    extendedDescription,
    locationType,
    display: "all",
    screensIds: [],
    public: "1",
    phone: e.custom_fields?.contact_phone_number || "",
  };

  if (website) payload.website = website;

  if (locationType === "ph2" || locationType === "bo") {
    payload.location = location;
    payload.placeId = "";
    payload.placeName = "";
  }
  if (locationType === "on" || locationType === "bo") {
    payload.urlLink = streamUrl || website || "https://calendar.oberlin.edu";
  }
  if (e.ticket_url) {
    payload.buttons = [{ title: "Learn More", link: e.ticket_url }];
  }

  // Pass image URL directly — CommunityHub API accepts image_cdn_url natively.
  // We store it as _photoUrl in Firestore; push-event/route.ts maps it to image_cdn_url.
  payload._photoUrl = e.photo_url || null;

  return payload;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const db = initFirebase();

  const pushedIds = loadPushedIds();
  console.log(`Loaded ${pushedIds.size} already-pushed IDs`);

  const processedIds = await loadProcessedIds(db);
  console.log(`Loaded ${processedIds.size} already-processed IDs from Firestore`);

  const seenIds = new Set([...pushedIds, ...processedIds]);

  const [events, chEvents] = await Promise.all([
    fetchLocalist(),
    fetchCommunityHubEvents(),
  ]);
  console.log(`Fetched ${events.length} live Localist events`);
  console.log(`Fetched ${chEvents.length} existing CommunityHub events`);

  let queued = 0;
  let skipped = 0;
  let duplicatesFlagged = 0;
  let rejectedPrivate = 0;
  let analyzed = 0;
  const runDuplicates = [];
  const runRejected = [];

  for (const e of events) {
    const id = String(e.id);

    if (seenIds.has(id)) {
      skipped++;
      continue;
    }

    analyzed++;
    const inst = e.event_instances?.[0]?.event_instance || {};

    const incoming = {
      id,
      source: "localist",
      title: e.title || "",
      date: inst.start ? new Date(inst.start).toISOString().slice(0, 10) : "",
      location: e.location_name || e.address || e.location || "",
      description: (e.description_text || "").slice(0, 300),
    };

    // ── Step 1: Duplicate Agent ──────────────────────────────────────────────
    const candidates = chEvents.filter(ch => mightBeDuplicate(incoming, ch));
    let isDuplicate = false;

    for (const ch of candidates) {
      const result = await geminiCheckDuplicate(incoming, ch);
      if (result?.isDuplicate && result.confidence >= 70) {
        isDuplicate = true;
        console.log(`⚠ Duplicate (${result.confidence}%): "${e.title}" ↔ "${ch.title}"`);
        runDuplicates.push({
          eventA: incoming,
          eventB: { id: String(ch.id), source: "communityhub", title: ch.title, date: ch.date, location: ch.location, description: ch.description },
          confidence: result.confidence,
          reason: result.reason,
          status: "pending",
          detectedAt: new Date().toISOString(),
        });
        break;
      }
    }

    if (isDuplicate) {
      duplicatesFlagged++;
      seenIds.add(id);
      continue;
    }

    // ── Step 2: Writer Agent ─────────────────────────────────────────────────
    const writerPayload = await buildWriterPayload(e);

    // ── Step 3: Public Agent ─────────────────────────────────────────────────
    const publicCheck = await geminiCheckPublic(e);

    if (!publicCheck.isPublic && publicCheck.confidence >= 75) {
      console.log(`✗ Private (${publicCheck.confidence}%): "${e.title}" — ${publicCheck.reason}`);
      rejectedPrivate++;
      seenIds.add(id);
      runRejected.push({
        localistId: id,
        source: "localist",
        reason: "private",
        confidence: publicCheck.confidence,
        geminiReason: publicCheck.reason,
        original: {
          title: e.title,
          date: inst.start || "",
          location: incoming.location,
          description: (e.description_text || "").slice(0, 500),
          sponsors: (e.filters?.departments || []).map(d => d.name),
          url: e.localist_url || "",
        },
        rejectedAt: new Date().toISOString(),
        status: "rejected",
      });
      continue;
    }

    // ── Step 4: Add to Review Queue ──────────────────────────────────────────
    console.log(`→ Queued for review: "${e.title}"`);
    queued++;
    seenIds.add(id);

    if (db) {
      await db.collection("review_queue").doc(id).set({
        localistId: id,
        source: "localist",
        status: "pending",
        detectedAt: new Date().toISOString(),
        publicCheck,
        original: {
          title: e.title,
          date: inst.start || "",
          endDate: inst.end || "",
          location: incoming.location,
          description: (e.description_text || "").replace(/<[^>]*>/g, " ").trim(),
          sponsors: (e.filters?.departments || []).map(d => d.name),
          url: e.localist_url || "",
          photoUrl: e.photo_url || null,
          experience: e.experience || "inperson",
        },
        writerPayload,
      });
    }
  }

  savePushedIds(pushedIds); // only pushed IDs (approval happens via dashboard)
  console.log(`Done — queued: ${queued}, skipped: ${skipped}, duplicates: ${duplicatesFlagged}, private: ${rejectedPrivate}`);

  if (db) {
    // Sync stats
    await db.collection("syncs").doc("localist").set({
      source: "Oberlin Localist",
      queued,
      skipped,
      skippedReason: "Already processed in a previous run",
      failed: 0,
      failedEvents: [],
      analyzed,
      duplicatesFlagged,
      rejectedPrivate,
      total: pushedIds.size,
      lastRun: new Date().toISOString(),
      geminiEnabled: !!GEMINI_API_KEY,
    });

    // Save duplicates
    for (const dup of runDuplicates) {
      const dupId = `${dup.eventA.id}_${dup.eventB.id}`;
      const existing = await db.collection("duplicates").doc(dupId).get();
      if (!existing.exists) await db.collection("duplicates").doc(dupId).set(dup);
    }

    // Save rejected
    for (const rej of runRejected) {
      await db.collection("rejected").doc(rej.localistId).set(rej);
    }

    console.log("Stats saved to Firestore.");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
