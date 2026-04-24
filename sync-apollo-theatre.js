/**
 * Apollo Theatre Sync Pipeline — apollo_theatre_v1
 *
 * Calls the Apollo Theatre ingester, then runs every staged event through:
 *   1. Duplicate Agent  (Gemini)
 *   2. Writer Agent     (payload builder + Gemini clean)
 *   3. Public Agent     (Gemini)
 * and writes survivors to Firestore review_queue.
 *
 * Run: node --env-file=.env sync-apollo-theatre.js
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runIngester } from "./ingest-apollo-theatre.js";
import {
  mightBeDuplicate,
  checkDuplicateInQueue,
  geminiCheckDuplicate as _geminiCheckDuplicate,
  makeRunDeduplicator,
  MIN_GEMINI_CONFIDENCE,
} from "./lib/duplicate-agent.js";

const OWNER_EMAIL  = "frankkusiap@gmail.com";
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
  "gallery": 2, "festival": 3, "fair": 3, "celebration": 3,
  "tour": 4, "open house": 4, "sport": 12, "game": 12,
  "recreation": 12, "networking": 13, "film": 9, "movie": 9,
  "cinema": 9, "screening": 9, "documentary": 9,
};

function inferPostTypeIds(title, desc) {
  const text = `${title || ""} ${desc || ""}`.toLowerCase();
  for (const [keyword, id] of Object.entries(POST_TYPE_MAP)) {
    if (text.includes(keyword)) return [id];
  }
  return [9]; // default to performance for a cinema
}

function toUnix(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// ─── Payload builder ─────────────────────────────────────────────────────────

async function buildPayloadFromStaged(ev) {
  const runtimeSec   = ev.runtime_seconds || 7200;
  const isOnline     = ev.location_type === "Online";
  const locationType = isOnline ? "on" : "ph2";

  // Apollo synopses are already clean API text — skip Gemini cleaning.
  const description         = (ev.short_description    || ev.title).slice(0, 200);
  const extendedDescription = (ev.extended_description || description).slice(0, 1000);

  // Build one session per showtime across the 14-day window.
  // raw_payload.showtimesForMovie = { "YYYY-MM-DD": [{ startsAt, isExpired, ... }] }
  const showtimesMap = ev.raw_payload?.showtimesForMovie || {};
  const sessions = [];
  for (const slots of Object.values(showtimesMap)) {
    for (const slot of slots) {
      if (slot.isExpired || !slot.startsAt) continue;
      const start = toUnix(slot.startsAt);
      sessions.push({ startTime: start, endTime: start + runtimeSec });
    }
  }
  // Sort sessions by startTime and deduplicate
  sessions.sort((a, b) => a.startTime - b.startTime);
  const uniqueSessions = sessions.filter(
    (s, i) => i === 0 || s.startTime !== sessions[i - 1].startTime
  );

  // Fallback: if nothing in showtimesMap, use the first showtime we stored
  if (!uniqueSessions.length) {
    const start = toUnix(ev.start_datetime || new Date().toISOString());
    uniqueSessions.push({ startTime: start, endTime: start + runtimeSec });
  }

  const payload = {
    eventType:           "ot",
    email:               OWNER_EMAIL,
    subscribe:           true,
    contactEmail:        OWNER_EMAIL,
    title:               (ev.title || "Untitled").slice(0, 60),
    sponsors:            [ev.organizational_sponsor || "Apollo Theatre"],
    postTypeId:          inferPostTypeIds(ev.title, ev.extended_description),
    sessions:            uniqueSessions,
    description,
    extendedDescription,
    locationType,
    display:             "all",
    screensIds:          [],
    public:              "1",
    phone:               ev.contact_phone || "",
    _photoUrl:           ev._photoUrl || null,
  };

  if (ev.event_link) payload.website = ev.event_link;

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
  if (!GEMINI_API_KEY) return { isPublic: true, confidence: 50, reason: "Gemini unavailable — defaulted to public" };
  const title = ev.title || "";
  const desc  = (ev.extended_description || ev.short_description || "").slice(0, 600);
  try {
    const raw = await geminiCall(`You are a public-access filter for a community calendar serving Oberlin, Ohio.

Can a regular town resident (no Oberlin College affiliation) attend this event?

PRIVATE (reject) if:
- Requires college affiliation, ID, or enrollment
- Faculty/staff/student-only meetings or events

PUBLIC (approve) if:
- Open to the Oberlin community or general public
- Movie screenings, film festivals open to ticket-buying public
- Public performances and entertainment

Note: Cinema screenings are generally public. Default to PUBLIC for movie listings.

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
      db.collection("review_queue").where("source_id", "==", "apollo_theatre").select("fingerprint").get(),
      db.collection("rejected").where("source_id", "==", "apollo_theatre").select("fingerprint").get(),
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
      headers: { "User-Agent": "apollo-theatre-sync-bot/1.0" },
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

  console.log("→ Running Apollo Theatre ingester…\n");
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

    const alreadyQueued = await checkDuplicateInQueue(db, incoming, "apollo_theatre");
    if (alreadyQueued) { skipped++; processedFps.add(fingerprint); continue; }

    const writerPayload = await buildPayloadFromStaged(ev);
    const publicCheck   = await geminiCheckPublic(ev);

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
    await db.collection("syncs").doc("apollo_theatre").set({
      source:            "Apollo Theatre",
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
