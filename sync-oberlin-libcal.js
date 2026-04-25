/**
 * Oberlin LibCal Sync Pipeline — oberlin_libcal_v1
 *
 * Calls the LibCal ingester, then runs every staged event through:
 *   1. Duplicate Agent  (Gemini)
 *   2. Writer Agent     (payload builder + Gemini description clean)
 *   3. Public Agent     (Gemini — filters college-only events)
 * and writes survivors to Firestore review_queue.
 *
 * Run: node --env-file=.env sync-oberlin-libcal.js
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runIngester } from "./ingest-oberlin-libcal.js";
import {
  mightBeDuplicate,
  checkDuplicateInQueue,
  geminiCheckDuplicate as _geminiCheckDuplicate,
  makeRunDeduplicator,
  MIN_GEMINI_CONFIDENCE,
} from "./lib/duplicate-agent.js";

const OWNER_EMAIL    = "frankkusiap@gmail.com";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = "gemini-2.5-flash";

const COMMUNITYHUB_POSTS_API =
  "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?limit=10000&page=0&filter=future&tab=main-feed&isJobs=false&order=ASC&postType=All&allPosts";

// ─── Firebase ─────────────────────────────────────────────────────────────────

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
  "gallery": 2, "display": 2, "festival": 3, "fair": 3,
  "celebration": 3, "tour": 4, "open house": 4, "film": 9,
  "movie": 9, "screening": 9, "documentary": 9, "book": 6,
  "reading": 6, "poetry": 6,
};

function inferPostTypeIds(title, desc, categories = []) {
  const text = `${title || ""} ${desc || ""} ${categories.join(" ")}`.toLowerCase();
  for (const [keyword, id] of Object.entries(POST_TYPE_MAP)) {
    if (text.includes(keyword)) return [id];
  }
  return [6]; // default to lecture/talk for library events
}

function toUnix(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// ─── Payload builder ─────────────────────────────────────────────────────────

async function buildPayloadFromStaged(ev, cleanedDesc) {
  const isOnline     = ev.location_type === "Online";
  const locationType = isOnline ? "on" : "ph2";

  const description         = (cleanedDesc || ev.short_description || ev.title).slice(0, 200);
  const extendedDescription = (cleanedDesc || ev.extended_description || description).slice(0, 1000);

  // Build session(s)
  const sessions = [];

  if (ev.all_day) {
    // All-day event: use midnight to midnight
    const startUnix = toUnix(ev.start_datetime);
    const endUnix   = ev.end_datetime ? toUnix(ev.end_datetime) : startUnix + 86400;
    sessions.push({ startTime: startUnix, endTime: endUnix });
  } else {
    const startUnix = toUnix(ev.start_datetime);
    const endUnix   = ev.end_datetime ? toUnix(ev.end_datetime) : startUnix + 3600;
    sessions.push({ startTime: startUnix, endTime: endUnix });
  }

  const payload = {
    eventType:           "ot",
    email:               OWNER_EMAIL,
    subscribe:           true,
    contactEmail:        OWNER_EMAIL,
    title:               (ev.title || "Untitled").slice(0, 60),
    sponsors:            [ev.organizational_sponsor || "Oberlin College Libraries"],
    postTypeId:          inferPostTypeIds(ev.title, ev.extended_description, ev.categories),
    sessions,
    description,
    extendedDescription,
    locationType,
    display:             "all",
    screensIds:          [],
    public:              "1",
    phone:               "",
    _photoUrl:           ev._photoUrl || null,
  };

  if (ev.event_link && ev.event_link !== "https://oberlin.libcal.com/calendar/events") {
    payload.website = ev.event_link;
  }

  if (!isOnline && ev.location_or_address) {
    payload.location  = ev.location_or_address;
    payload.placeId   = "";
    payload.placeName = "";
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
- Remove any HTML tags or entities that slipped through
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
  return _geminiCheckDuplicate(incoming, existing, GEMINI_API_KEY);
}

async function geminiCheckPublic(ev) {
  if (!GEMINI_API_KEY) {
    return { isPublic: true, confidence: 50, reason: "Gemini unavailable — defaulted to public" };
  }
  const title = ev.title || "";
  const desc  = (ev.extended_description || ev.short_description || "").slice(0, 600);
  const cats  = (ev.categories || []).join(", ");
  try {
    const raw = await geminiCall(`You are a public-access filter for a community calendar serving Oberlin, Ohio.

Can a regular town resident (no Oberlin College affiliation) attend this event?

PRIVATE (reject) if:
- Requires Oberlin College student/faculty/staff ID or enrollment
- Internal department meetings, faculty colloquia, or staff-only events
- Orientation sessions or events restricted to students

PUBLIC (approve) if:
- Open to the Oberlin community or general public (the library often says so explicitly)
- Free events at the library open to all
- Author talks, book displays, art exhibitions, concerts, film screenings open to all
- Events where "open to the public" or "free and open" is stated

Note: Oberlin College Libraries events are generally open to the public. Default to PUBLIC when uncertain.

Event:
- Title: ${title}
- Categories: ${cats}
- Description: ${desc}

Reply with JSON only — no markdown:
{"isPublic": true, "confidence": 0-100, "reason": "one sentence"}`);
    return JSON.parse((raw || "{}").replace(/```json\n?|```/g, "").trim());
  } catch (err) {
    console.warn(`Public Agent failed: ${err.message} — defaulting to public`);
    return { isPublic: true, confidence: 50, reason: "Could not determine — defaulted to public" };
  }
}

function localMightBeDuplicate(incoming, chEvent) {
  const { verdict, reason } = mightBeDuplicate(incoming, chEvent);
  if (verdict) console.log(`  ↗ Candidate pair: ${reason}`);
  return verdict;
}

// ─── Load already-processed fingerprints ─────────────────────────────────────

async function loadProcessedFingerprints(db) {
  if (!db) return new Set();
  try {
    const [queueSnap, rejectedSnap] = await Promise.all([
      db.collection("review_queue").where("source_id", "==", "oberlin_libcal").select("fingerprint").get(),
      db.collection("rejected").where("source_id", "==", "oberlin_libcal").select("fingerprint").get(),
    ]);
    const fps = new Set();
    for (const doc of [...queueSnap.docs, ...rejectedSnap.docs]) {
      fps.add(doc.data().fingerprint || doc.id);
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
      headers: { "User-Agent": "oberlin-libcal-sync-bot/1.0" },
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

  console.log("→ Running Oberlin LibCal ingester…\n");
  const { stagedEvents, candidates } = await runIngester();
  console.log(`\n→ ${stagedEvents.length} events eligible for pipeline\n`);

  const processedFps = await loadProcessedFingerprints(db);
  console.log(`Loaded ${processedFps.size} already-processed fingerprints from Firestore`);

  const chEvents = await fetchCommunityHubEvents();
  console.log(`Fetched ${chEvents.length} existing CommunityHub events`);

  let queued = 0, skipped = 0, duplicatesFlagged = 0, rejectedPrivate = 0, analyzed = 0;
  const runDuplicates = [];
  const runRejected   = [];
  const seenThisRun   = makeRunDeduplicator();

  for (let i = 0; i < stagedEvents.length; i++) {
    const ev          = stagedEvents[i];
    const candidate   = candidates[i];
    const fingerprint = candidate.fingerprint;

    if (processedFps.has(fingerprint)) { skipped++; continue; }

    analyzed++;

    const incoming = {
      id:          fingerprint,
      source:      ev.source_id,
      title:       ev.title || "",
      date:        ev.start_datetime ? ev.start_datetime.slice(0, 10) : "",
      location:    ev.location_or_address || "",
      description: (ev.short_description || "").slice(0, 300),
    };

    if (seenThisRun(incoming)) { skipped++; processedFps.add(fingerprint); continue; }

    // ── Duplicate check ───────────────────────────────────────────────────────
    const dupCandidates = chEvents.filter(ch => localMightBeDuplicate(incoming, ch));
    let isDuplicate = false;

    for (const ch of dupCandidates) {
      const result = await geminiCheckDuplicate(incoming, ch);
      if (result?.isDuplicate && result.confidence >= MIN_GEMINI_CONFIDENCE) {
        isDuplicate = true;
        console.log(`⚠ Duplicate (${result.confidence}%): "${ev.title}" ↔ "${ch.title}" — ${result.reason}`);
        runDuplicates.push({
          eventA:     incoming,
          eventB:     { id: String(ch.id), source: "communityhub", title: ch.title, date: ch.date, location: ch.location },
          confidence: result.confidence,
          reason:     result.reason,
          status:     "pending",
          detectedAt: new Date().toISOString(),
        });
        break;
      } else if (result) {
        console.log(`  ✓ Not duplicate (${result.confidence}%): "${ev.title}" — ${result.reason}`);
      }
    }

    if (isDuplicate) { duplicatesFlagged++; processedFps.add(fingerprint); continue; }

    const alreadyQueued = await checkDuplicateInQueue(db, incoming, "oberlin_libcal");
    if (alreadyQueued) { skipped++; processedFps.add(fingerprint); continue; }

    // ── Public check ──────────────────────────────────────────────────────────
    const publicCheck = await geminiCheckPublic(ev);

    if (!publicCheck.isPublic && publicCheck.confidence >= 75) {
      console.log(`✗ Private (${publicCheck.confidence}%): "${ev.title}" — ${publicCheck.reason}`);
      rejectedPrivate++;
      processedFps.add(fingerprint);
      runRejected.push({
        fingerprint,
        source_id:    ev.source_id,
        source:       ev.source_name,
        reason:       "private",
        confidence:   publicCheck.confidence,
        geminiReason: publicCheck.reason,
        original: {
          title:       ev.title,
          date:        ev.start_datetime || "",
          location:    ev.location_or_address || "",
          description: (ev.extended_description || "").slice(0, 500),
          url:         ev.event_link || "",
        },
        rejectedAt: new Date().toISOString(),
        status:     "rejected",
      });
      continue;
    }

    // ── Writer Agent ──────────────────────────────────────────────────────────
    const cleanedDesc  = await geminiClean(ev.extended_description, 900);
    const writerPayload = await buildPayloadFromStaged(ev, cleanedDesc);

    console.log(`→ Queued for review: "${ev.title}"`);
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
          url:         ev.event_link || "",
          photoUrl:    ev._photoUrl || null,
        },
        writerPayload,
      });
    }
  }

  console.log(`\nDone — queued: ${queued}, skipped: ${skipped}, duplicates: ${duplicatesFlagged}, private: ${rejectedPrivate}`);

  if (db) {
    await db.collection("syncs").doc("oberlin_libcal").set({
      source:            "Oberlin College Libraries (LibCal)",
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
      const dupId = `${dup.eventA.id}_${dup.eventB.id}`;
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
