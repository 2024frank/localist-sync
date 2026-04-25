/**
 * pipeline.js — Shared AI pipeline for AMAM and Oberlin Heritage Center
 * ─────────────────────────────────────────────────────────────────────────────
 * Takes a list of staged events from any ingester adapter and runs each
 * through three sequential AI agents:
 *
 *   1. Duplicate Agent  — is this already on CommunityHub?
 *   2. Public Agent     — can any Oberlin resident attend (no affiliation)?
 *   3. Writer Agent     — build a clean CommunityHub-ready payload
 *
 * Survivors are written to Firestore `review_queue` for human approval.
 * Nothing is ever posted automatically.
 *
 * Used by: sync-amam.js, sync-heritage-center.js
 * For Localist the equivalent logic lives inline in sync.js (older pattern).
 * Newer sources (Apollo, LibCal) each embed their own pipeline variation
 * so they can customise the Writer Agent prompt for their data format.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

// Pull all currently posted events so the Duplicate Agent can compare against them.
const COMMUNITYHUB_POSTS_API =
  "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?limit=10000&page=0&filter=future&tab=main-feed&isJobs=false&order=ASC&postType=All&allPosts";

// ─── Firebase ─────────────────────────────────────────────────────────────────

/**
 * Initialize Firebase Admin SDK once (idempotent — safe to call multiple times).
 * Returns a Firestore instance, or null if credentials are missing/invalid.
 * When null, pipeline stats and queue writes are silently skipped.
 */
export function initFirebase() {
  if (getApps().length > 0) return getFirestore();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.warn("No FIREBASE_SERVICE_ACCOUNT — Firestore disabled."); return null; }
  try {
    initializeApp({ credential: cert(JSON.parse(raw)) });
    return getFirestore();
  } catch (err) {
    console.warn("Firebase init failed:", err.message);
    return null;
  }
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────

/**
 * Raw call to the Gemini generateContent endpoint.
 * Returns the model's text response, or null if the API key is missing.
 * Throws on HTTP errors so callers can decide whether to retry or fallback.
 */
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

// ─── Agent 2: Public check ────────────────────────────────────────────────────

/**
 * Ask Gemini whether a regular Oberlin town resident (no college affiliation)
 * can attend this event. Returns { isPublic, confidence, reason }.
 *
 * Threshold: events are rejected only when isPublic === false AND
 * confidence ≥ 75. Below 75 we default to public to avoid false positives.
 */
async function geminiCheckPublic(title, description) {
  // If Gemini is unavailable, let everything through — better than blocking valid events.
  if (!GEMINI_API_KEY) return { isPublic: true, confidence: 50, reason: "Gemini unavailable — defaulted to public" };
  const desc = (description || "").slice(0, 600); // keep prompt cost low
  try {
    const raw = await geminiCall(`You are a public-access filter agent for a community calendar serving the town of Oberlin, Ohio.

The ONLY question: Can a regular Oberlin town resident — someone with ZERO Oberlin College affiliation — walk in and attend this event?

PRIVATE (reject) if ANY of these apply:
- Requires being an Oberlin College student, faculty, staff, or affiliate
- Academic deadlines, grading policies, advising, tutoring, registration
- Department/faculty/staff meetings or student org meetings
- Requires college login, ID card, or enrollment to attend
- Career/recruiting events restricted to enrolled students

PUBLIC (approve) if a non-affiliated town resident can genuinely attend:
- Open to the Oberlin community or general public with no affiliation required
- Public lectures, performances, concerts, exhibitions, open houses, festivals, museum events

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

// ─── CommunityHub snapshot ────────────────────────────────────────────────────

/**
 * Fetch all future events currently on CommunityHub for duplicate comparison.
 * Returns a flat array of { id, title, date, location } objects.
 * Returns [] on any network failure so the pipeline can continue without
 * duplicate checking (better than crashing the whole run).
 */
async function fetchCommunityHubEvents() {
  try {
    const res = await fetch(COMMUNITYHUB_POSTS_API, { headers: { "User-Agent": "localist-sync-bot/1.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.posts || []).map(p => ({
      id: p.id,
      title: p.name || "",
      // Convert Unix session start to YYYY-MM-DD for date-window comparison
      date: p.sessions?.[0]?.start ? new Date(p.sessions[0].start * 1000).toISOString().slice(0, 10) : "",
      location: p.location?.name || p.location?.address || "",
    }));
  } catch { return []; }
}

// ─── Agent 1: Duplicate check (Gemini) ───────────────────────────────────────

/**
 * Ask Gemini whether two pre-filtered events are the same real-world occurrence.
 * Only called after the cheap CPU pre-filter (mightBeDuplicate) returns true.
 * Returns { isDuplicate, confidence, reason } or null on error.
 */
async function geminiCheckDuplicate(incoming, existing) {
  if (!GEMINI_API_KEY) return null;
  try {
    const raw = await geminiCall(`You are a duplicate detection agent for a community calendar.

Determine if these two events are the SAME real-world event.

Incoming:
- Title: ${incoming.title}
- Date: ${incoming.date}
- Location: ${incoming.location}

Existing on CommunityHub:
- Title: ${existing.title}
- Date: ${existing.date}
- Location: ${existing.location}

Reply with JSON only — no markdown:
{"isDuplicate": true, "confidence": 0-100, "reason": "one sentence"}`);
    return JSON.parse((raw || "{}").replace(/```json\n?|```/g, "").trim());
  } catch { return null; }
}

// ─── Cheap pre-filter (before Gemini) ────────────────────────────────────────

/**
 * CPU-only pre-filter: same date AND at least one title word (>3 chars) in common.
 * Much simpler than the version in lib/duplicate-agent.js; suitable for sources
 * where events are already well-structured. Returns boolean.
 */
function mightBeDuplicate(incoming, chEvent) {
  if (!incoming.date || !chEvent.date) return false;
  if (incoming.date !== chEvent.date) return false; // exact date match required
  const inTitle = new Set(incoming.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const chWords = (chEvent.title || "").toLowerCase().split(/\W+/).filter(w => w.length > 3);
  return chWords.some(w => inTitle.has(w));
}

// ─── Agent 3: Writer — CommunityHub payload builder ───────────────────────────

/**
 * Build the CommunityHub POST payload from a staged event.
 * Uses simple field mapping — no Gemini cleaning here because sources using
 * this shared pipeline (AMAM, Heritage) already have clean text.
 *
 * contactEmail is always the owner's email — never pulled from the source event.
 */
function buildWriterPayload(staged) {
  // Convert ISO datetimes to Unix seconds (CommunityHub requires Unix)
  const startTime = staged.start_datetime
    ? Math.floor(new Date(staged.start_datetime).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  const endTime = staged.end_datetime
    ? Math.floor(new Date(staged.end_datetime).getTime() / 1000)
    : startTime + 3600; // default 1-hour event if no end time

  const isOnline = staged.location_type === "Online";
  const locationType = isOnline ? "on" : "ph2"; // CommunityHub location type codes

  const payload = {
    eventType: "ot",           // "ot" = one-time event (vs recurring)
    email: "frankkusiap@gmail.com",
    subscribe: true,
    contactEmail: "frankkusiap@gmail.com",  // always owner email, ignore source
    title: (staged.title || "Untitled Event").slice(0, 60), // CH enforces 60-char limit
    sponsors: [staged.organizational_sponsor || "Oberlin Community"],
    postTypeId: [89],          // 89 = Other; individual sync scripts use richer mapping
    sessions: [{ startTime, endTime }],
    description: staged.short_description || "No description provided.",
    extendedDescription: staged.extended_description || staged.short_description || "",
    locationType,
    display: "all",
    screensIds: [],
    public: "1",
    phone: staged.contact_phone || "",
    _photoUrl: staged._photoUrl || null, // picked up by push-event route at approval time
  };

  // Location fields differ by event type: in-person gets address; virtual gets a stream URL
  if (!isOnline) {
    payload.location = staged.location_or_address || "Oberlin, OH";
    payload.placeId = "";
    payload.placeName = "";
  } else {
    payload.urlLink = staged.event_link || "https://oberlin.edu";
  }

  if (staged.event_link) payload.website = staged.event_link;

  return payload;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full three-agent pipeline for a batch of staged events.
 *
 * Flow per event:
 *   already processed? → skip
 *   → Duplicate Agent (cheap pre-filter + Gemini)
 *   → Public Agent (Gemini)
 *   → Writer Agent (payload builder)
 *   → write to Firestore review_queue
 *
 * At the end, save per-run stats and any duplicate/rejected records to Firestore.
 *
 * @param {object[]} stagedEvents  Raw events from an ingester's runIngester()
 * @param {string}   sourceId      Firestore doc key, e.g. "amam"
 * @param {string}   sourceName    Human-readable label for stats display
 */
export async function runPipeline(stagedEvents, sourceId, sourceName) {
  const db = initFirebase();

  // ── Load already-processed IDs (skip events seen in prior runs) ──────────
  const processedIds = new Set();
  if (db) {
    try {
      const [qSnap, rSnap] = await Promise.all([
        // Check both review_queue (already queued) and rejected (already filtered)
        db.collection("review_queue").where("source", "==", sourceId).select().get(),
        db.collection("rejected").where("source", "==", sourceId).select().get(),
      ]);
      qSnap.docs.forEach(d => processedIds.add(d.id));
      rSnap.docs.forEach(d => processedIds.add(d.id));
    } catch (err) {
      console.warn("Could not load processedIds:", err.message);
    }
  }
  console.log(`Loaded ${processedIds.size} already-processed IDs for ${sourceId}`);

  const chEvents = await fetchCommunityHubEvents();
  console.log(`Fetched ${chEvents.length} existing CommunityHub events`);

  let queued = 0, skipped = 0, duplicatesFlagged = 0, rejectedPrivate = 0, analyzed = 0;
  const runRejected = [];   // collected and batch-written at end to reduce Firestore calls
  const runDuplicates = []; // same

  for (const staged of stagedEvents) {
    // Build a stable document ID from the event fingerprint or a title+date slug
    const fingerprint = staged.fingerprint ||
      `${sourceId}_${(staged.title || "").slice(0, 30)}_${staged.start_datetime || ""}`;
    const docId = fingerprint.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);

    if (processedIds.has(docId)) { skipped++; continue; }

    analyzed++;

    const incomingDate = staged.start_datetime ? staged.start_datetime.slice(0, 10) : "";
    // Minimal event representation used for duplicate comparison
    const incoming = { title: staged.title || "", date: incomingDate, location: staged.location_or_address || "" };

    // ── Agent 1: Duplicate check ─────────────────────────────────────────────
    // First pass: cheap CPU pre-filter (same date + title word overlap)
    const candidates = chEvents.filter(ch => mightBeDuplicate(incoming, ch));
    let isDuplicate = false;

    for (const ch of candidates) {
      // Second pass: Gemini confirms at ≥ 70% confidence
      const result = await geminiCheckDuplicate(incoming, ch);
      if (result?.isDuplicate && result.confidence >= 70) {
        isDuplicate = true;
        console.log(`⚠ Duplicate (${result.confidence}%): "${staged.title}" ↔ "${ch.title}"`);
        runDuplicates.push({
          eventA: { id: docId, source: sourceId, ...incoming },
          eventB: { id: String(ch.id), source: "communityhub", title: ch.title, date: ch.date, location: ch.location },
          confidence: result.confidence,
          reason: result.reason,
          status: "pending",
          detectedAt: new Date().toISOString(),
        });
        break; // one confirmed duplicate is enough — stop checking candidates
      }
    }

    if (isDuplicate) { duplicatesFlagged++; processedIds.add(docId); continue; }

    // ── Agent 2: Public access check ─────────────────────────────────────────
    const publicCheck = await geminiCheckPublic(staged.title, staged.extended_description || staged.short_description);

    if (!publicCheck.isPublic && publicCheck.confidence >= 75) {
      console.log(`✗ Private (${publicCheck.confidence}%): "${staged.title}" — ${publicCheck.reason}`);
      rejectedPrivate++;
      processedIds.add(docId);
      runRejected.push({
        localistId: docId,
        source: sourceId,
        reason: "private",
        confidence: publicCheck.confidence,
        geminiReason: publicCheck.reason,
        original: {
          title: staged.title,
          date: staged.start_datetime || "",
          location: staged.location_or_address || "",
          description: (staged.extended_description || staged.short_description || "").slice(0, 500),
          sponsors: [staged.organizational_sponsor || ""],
          url: staged.event_link || "",
        },
        rejectedAt: new Date().toISOString(),
        status: "rejected",
      });
      continue;
    }

    // ── Agent 3: Writer — build CommunityHub payload ──────────────────────────
    console.log(`→ Queued for review: "${staged.title}"`);
    queued++;
    processedIds.add(docId);

    if (db) {
      await db.collection("review_queue").doc(docId).set({
        localistId: docId,
        source: sourceId,
        status: "pending",
        detectedAt: new Date().toISOString(),
        publicCheck,    // stored so the dashboard can show the Gemini confidence score
        original: {
          title: staged.title,
          date: staged.start_datetime || "",
          endDate: staged.end_datetime || "",
          location: staged.location_or_address || "",
          description: staged.extended_description || staged.short_description || "",
          sponsors: [staged.organizational_sponsor || ""],
          url: staged.event_link || "",
          photoUrl: staged._photoUrl || null,
          experience: staged.location_type === "Online" ? "virtual" : "inperson",
        },
        writerPayload: buildWriterPayload(staged), // what will be sent to CH on approval
      });
    }
  }

  // ── Persist stats, duplicates, and rejected records ───────────────────────
  if (db) {
    // Sync stats shown on the Sources dashboard page
    await db.collection("syncs").doc(sourceId).set({
      source: sourceName,
      queued, skipped, analyzed,
      duplicatesFlagged, rejectedPrivate,
      failed: 0,
      total: queued,
      lastRun: new Date().toISOString(),
      geminiEnabled: !!GEMINI_API_KEY,
    });

    // Only write duplicates that don't already exist in Firestore
    for (const dup of runDuplicates) {
      const dupId = `${dup.eventA.id}_${dup.eventB.id}`;
      const existing = await db.collection("duplicates").doc(dupId).get();
      if (!existing.exists) await db.collection("duplicates").doc(dupId).set(dup);
    }

    for (const rej of runRejected) {
      await db.collection("rejected").doc(rej.localistId).set(rej);
    }

    console.log("Stats saved to Firestore.");
  }

  console.log(`Done — queued: ${queued}, skipped: ${skipped}, duplicates: ${duplicatesFlagged}, private: ${rejectedPrivate}`);
}
