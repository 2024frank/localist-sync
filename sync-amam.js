/**
 * AMAM Sync Pipeline — amam_camoufox_v1
 *
 * Calls the AMAM ingester, then runs every staged event through:
 *   1. Duplicate Agent  (Gemini)
 *   2. Writer Agent     (payload builder + Gemini clean)
 *   3. Public Agent     (Gemini)
 * and writes survivors to Firestore review_queue.
 *
 * Run: node --env-file=.env sync-amam.js
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runIngester } from "./ingest-amam.js";

const FALLBACK_EMAIL = process.env.FALLBACK_EMAIL || "fkusiapp@oberlin.edu";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = "gemini-2.5-flash";

const COMMUNITYHUB_POSTS_API =
  "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?limit=10000&page=0&filter=future&tab=main-feed&isJobs=false&order=ASC&postType=All&allPosts";

// ─── Firebase ────────────────────────────────────────────────────────────────

function initFirebase() {
  if (getApps().length > 0) return getFirestore();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    initializeApp({ credential: cert(sa) });
    return getFirestore();
  } catch {
    console.warn("Could not init Firebase — stats will not be saved.");
    return null;
  }
}

// ─── Post-type map ────────────────────────────────────────────────────────────

const POST_TYPE_MAP = {
  "lecture": 6, "talk": 6, "presentation": 6, "seminar": 6,
  "symposium": 6, "conference": 6, "music": 8, "concert": 8,
  "performance": 9, "theatre": 9, "theater": 9, "dance": 9,
  "workshop": 7, "class": 7, "exhibit": 2, "exhibition": 2,
  "gallery": 2, "festival": 3, "fair": 3, "celebration": 3,
  "tour": 4, "open house": 4, "sport": 12, "game": 12,
  "recreation": 12, "networking": 13,
};

function inferPostTypeIds(title, desc, kind) {
  if (kind === "exhibition") return [2];
  const text = `${title || ""} ${desc || ""}`.toLowerCase();
  for (const [keyword, id] of Object.entries(POST_TYPE_MAP)) {
    if (text.includes(keyword)) return [id];
  }
  return [89]; // other
}

function toUnix(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// ─── Payload builder ─────────────────────────────────────────────────────────

async function buildPayloadFromStaged(ev) {
  const kind      = ev.raw_payload?.kind || "event";
  const startTime = ev.start_datetime ? toUnix(ev.start_datetime) : toUnix(new Date().toISOString());
  const endTime   = ev.end_datetime   ? toUnix(ev.end_datetime)   : startTime + 3600;
  const isOnline  = ev.location_type === "Online";
  const locationType = isOnline ? "on" : "ph2";

  // Optionally clean description with Gemini
  let description         = ev.short_description    || ev.title;
  let extendedDescription = ev.extended_description || description;

  if (GEMINI_API_KEY && ev.extended_description) {
    const cleaned = await geminiClean(ev.extended_description, 200);
    if (cleaned) description = cleaned;
    const ext = await geminiClean(ev.extended_description, 1000);
    if (ext) extendedDescription = ext;
  }

  const payload = {
    eventType:          "ot",
    email:              ev.contact_email || FALLBACK_EMAIL,
    subscribe:          true,
    contactEmail:       ev.contact_email || FALLBACK_EMAIL,
    title:              (ev.title || "Untitled").slice(0, 60),
    sponsors:           [ev.organizational_sponsor || ev.source_name || "Allen Memorial Art Museum"],
    postTypeId:         inferPostTypeIds(ev.title, ev.extended_description, kind),
    sessions:           [{ startTime, endTime }],
    description:        description || "No description provided.",
    extendedDescription: extendedDescription || description || "No description provided.",
    locationType,
    display:            "all",
    screensIds:         [],
    public:             "1",
    phone:              ev.contact_phone || "",
    _photoUrl:          ev._photoUrl || null,
  };

  if (ev.event_link) payload.website = ev.event_link;

  if (!isOnline && ev.location_or_address) {
    payload.location  = ev.location_or_address;
    payload.placeId   = "";
    payload.placeName = "";
  }
  if (isOnline) {
    payload.urlLink = ev.event_link || ev.listing_url || "";
  }

  return payload;
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────

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

async function geminiClean(rawText, maxChars) {
  if (!GEMINI_API_KEY || !rawText) return null;
  try {
    return await geminiCall(`You are cleaning an event description for a community calendar.

Instructions:
- Remove ALL URLs (http/https links)
- Remove streaming video references
- Summarize to under ${maxChars} characters
- End at a complete sentence boundary
- Return ONLY the cleaned text — no quotes, no explanation

Description:
"""
${rawText}
"""`);
  } catch (err) {
    console.warn(`Writer Agent failed: ${err.message}`);
    return null;
  }
}

async function geminiCheckDuplicate(incoming, existing) {
  if (!GEMINI_API_KEY) return null;
  try {
    const raw = await geminiCall(`You are a duplicate detection agent for a community calendar.

Determine if these two events are the SAME real-world event.

Incoming:
- Title: ${incoming.title}
- Date: ${incoming.date}
- Location: ${incoming.location}

Existing:
- Title: ${existing.title}
- Date: ${existing.date}
- Location: ${existing.location}

Reply with JSON only — no markdown:
{"isDuplicate": true, "confidence": 0-100, "reason": "one sentence"}`);
    return JSON.parse((raw || "{}").replace(/```json\n?|```/g, "").trim());
  } catch (err) {
    console.warn(`Duplicate Agent failed: ${err.message}`);
    return null;
  }
}

async function geminiCheckPublic(ev) {
  if (!GEMINI_API_KEY) return { isPublic: true, confidence: 50, reason: "Gemini unavailable — defaulted to public" };
  const title = ev.title || "";
  const desc  = (ev.extended_description || ev.short_description || "").slice(0, 600);
  try {
    const raw = await geminiCall(`You are a public-access filter for a community calendar serving Oberlin, Ohio.

Can a regular town resident (no Oberlin College affiliation) attend this event?

PRIVATE (reject) if:
- Requires college affiliation, ID, or enrollment
- Faculty/staff/student-only meetings or events
- Academic deadlines, advising, registration

PUBLIC (approve) if:
- Open to the Oberlin community or general public
- Public lectures, performances, exhibitions, festivals, open houses

When in doubt, mark PRIVATE.

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

// ─── Pre-filter for duplicates ────────────────────────────────────────────────

function mightBeDuplicate(incoming, chEvent) {
  if (!incoming.date || !chEvent.date) return false;
  if (incoming.date !== chEvent.date) return false;
  const inTitle = new Set(incoming.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const chWords = (chEvent.title || "").toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (chWords.some(w => inTitle.has(w))) return true;
  const a = (incoming.location || "").toLowerCase();
  const b = (chEvent.location || "").toLowerCase();
  if (!a || !b) return true;
  const aWords = new Set(a.split(/\W+/).filter(w => w.length > 3));
  return b.split(/\W+/).filter(w => w.length > 3).some(w => aWords.has(w));
}

// ─── Load already-processed fingerprints from Firestore ───────────────────────

async function loadProcessedFingerprints(db) {
  if (!db) return new Set();
  try {
    const [queueSnap, rejectedSnap] = await Promise.all([
      db.collection("review_queue").where("source_id", "==", "amam").select("fingerprint").get(),
      db.collection("rejected").where("source_id", "==", "amam").select("fingerprint").get(),
    ]);
    const fps = new Set();
    for (const doc of [...queueSnap.docs, ...rejectedSnap.docs]) {
      const fp = doc.data().fingerprint || doc.id;
      fps.add(fp);
    }
    return fps;
  } catch {
    return new Set();
  }
}

// ─── Fetch existing CommunityHub events ───────────────────────────────────────

async function fetchCommunityHubEvents() {
  try {
    const res = await fetch(COMMUNITYHUB_POSTS_API, {
      headers: { "User-Agent": "amam-sync-bot/1.0" },
    });
    if (!res.ok) throw new Error(`CommunityHub HTTP ${res.status}`);
    const data = await res.json();
    return (data.posts || []).map(p => ({
      id: p.id,
      title: p.name || "",
      date: p.sessions?.[0]?.start
        ? new Date(p.sessions[0].start * 1000).toISOString().slice(0, 10)
        : "",
      location: p.location?.name || p.location?.address || "",
    }));
  } catch (err) {
    console.warn(`Could not fetch CommunityHub events: ${err.message}`);
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = initFirebase();

  console.log("→ Running AMAM ingester…\n");
  const { stagedEvents, candidates } = await runIngester();
  console.log(`\n→ ${stagedEvents.length} events eligible for pipeline\n`);

  const processedFps = await loadProcessedFingerprints(db);
  console.log(`Loaded ${processedFps.size} already-processed fingerprints from Firestore`);

  const chEvents = await fetchCommunityHubEvents();
  console.log(`Fetched ${chEvents.length} existing CommunityHub events`);

  let queued            = 0;
  let skipped           = 0;
  let duplicatesFlagged = 0;
  let rejectedPrivate   = 0;
  let analyzed          = 0;
  const runDuplicates   = [];
  const runRejected     = [];

  for (let i = 0; i < stagedEvents.length; i++) {
    const ev          = stagedEvents[i];
    const candidate   = candidates[i];
    const fingerprint = candidate.fingerprint;

    if (processedFps.has(fingerprint)) {
      skipped++;
      continue;
    }

    analyzed++;
    const kind = ev.raw_payload?.kind || "event";

    const incoming = {
      id:          fingerprint,
      source:      ev.source_id,
      title:       ev.title || "",
      date:        ev.start_datetime ? ev.start_datetime.slice(0, 10) : "",
      location:    ev.location_or_address || "",
      description: (ev.short_description || "").slice(0, 300),
    };

    // ── Step 1: Duplicate Agent ──────────────────────────────────────────────
    const dupCandidates = chEvents.filter(ch => mightBeDuplicate(incoming, ch));
    let isDuplicate = false;

    for (const ch of dupCandidates) {
      const result = await geminiCheckDuplicate(incoming, ch);
      if (result?.isDuplicate && result.confidence >= 70) {
        isDuplicate = true;
        console.log(`⚠ Duplicate (${result.confidence}%): "${ev.title}" ↔ "${ch.title}"`);
        runDuplicates.push({
          eventA:     incoming,
          eventB:     { id: String(ch.id), source: "communityhub", title: ch.title, date: ch.date, location: ch.location },
          confidence: result.confidence,
          reason:     result.reason,
          status:     "pending",
          detectedAt: new Date().toISOString(),
        });
        break;
      }
    }

    if (isDuplicate) {
      duplicatesFlagged++;
      processedFps.add(fingerprint);
      continue;
    }

    // ── Step 2: Writer Agent ─────────────────────────────────────────────────
    const writerPayload = await buildPayloadFromStaged(ev);

    // ── Step 3: Public Agent ─────────────────────────────────────────────────
    // AMAM exhibitions and events are by default public — but still check
    const publicCheck = await geminiCheckPublic(ev);

    if (!publicCheck.isPublic && publicCheck.confidence >= 75) {
      console.log(`✗ Private (${publicCheck.confidence}%): "${ev.title}" — ${publicCheck.reason}`);
      rejectedPrivate++;
      processedFps.add(fingerprint);
      runRejected.push({
        fingerprint,
        source_id:   ev.source_id,
        source:      ev.source_name,
        reason:      "private",
        confidence:  publicCheck.confidence,
        geminiReason: publicCheck.reason,
        original: {
          title:       ev.title,
          date:        ev.start_datetime || "",
          location:    ev.location_or_address || "",
          description: (ev.extended_description || "").slice(0, 500),
          kind,
          url:         ev.event_link || "",
        },
        rejectedAt: new Date().toISOString(),
        status:     "rejected",
      });
      continue;
    }

    // ── Step 4: Review Queue ─────────────────────────────────────────────────
    console.log(`→ Queued for review: "${ev.title}" [${kind}]`);
    queued++;
    processedFps.add(fingerprint);

    if (db) {
      await db.collection("review_queue").doc(fingerprint).set({
        fingerprint,
        source_id:   ev.source_id,
        source:      ev.source_name,
        adapter_key: ev.adapter_key,
        status:      "pending",
        detectedAt:  new Date().toISOString(),
        publicCheck,
        original: {
          title:       ev.title,
          date:        ev.start_datetime || "",
          endDate:     ev.end_datetime   || "",
          location:    ev.location_or_address || "",
          description: ev.extended_description || ev.short_description || "",
          kind,
          url:         ev.event_link || "",
          photoUrl:    ev._photoUrl || null,
        },
        writerPayload,
      });
    }
  }

  console.log(`\nDone — queued: ${queued}, skipped: ${skipped}, duplicates: ${duplicatesFlagged}, private: ${rejectedPrivate}`);

  if (db) {
    await db.collection("syncs").doc("amam").set({
      source:            "Allen Memorial Art Museum (AMAM)",
      queued,
      skipped,
      skippedReason:     "Already processed in a previous run",
      failed:            0,
      failedEvents:      [],
      analyzed,
      duplicatesFlagged,
      rejectedPrivate,
      total:             stagedEvents.length,
      lastRun:           new Date().toISOString(),
      geminiEnabled:     !!GEMINI_API_KEY,
    });

    for (const dup of runDuplicates) {
      const dupId   = `${dup.eventA.id}_${dup.eventB.id}`;
      const existing = await db.collection("duplicates").doc(dupId).get();
      if (!existing.exists) await db.collection("duplicates").doc(dupId).set(dup);
    }

    for (const rej of runRejected) {
      await db.collection("rejected").doc(rej.fingerprint).set(rej);
    }

    console.log("Stats saved to Firestore.");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
