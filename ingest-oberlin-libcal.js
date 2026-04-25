/**
 * Oberlin LibCal Event Ingester — oberlin_libcal_v1
 * Adapter for: Oberlin College Libraries calendar (LibCal)
 *
 * Uses the LibCal AJAX JSON API — no browser needed.
 *
 * Approach:
 *   1. GET /ajax/calendar/list?c=10805&date=0000-00-00&perpage=100&page=N
 *      → paginate until all results fetched
 *   2. Filter to events starting in the next WINDOW_DAYS days
 *   3. Strip HTML from description, use shortdesc as fallback
 *   4. Use featured_image CloudFront URL directly as _photoUrl
 *   5. One stagedEvent per calendar event
 *
 * Run: node --env-file=.env ingest-oberlin-libcal.js
 */

import crypto from "crypto";
import { fileURLToPath } from "url";

const SOURCE = {
  id:               "oberlin_libcal",
  source_name:      "Oberlin College Libraries",
  adapter_key:      "oberlin_libcal_v1",
  listing_url:      "https://oberlin.libcal.com/calendar/events",
  default_location: "Oberlin College Libraries, Oberlin, OH 44074",
};

const LIBCAL_API  = "https://oberlin.libcal.com/ajax/calendar/list";
const CALENDAR_ID = "10805"; // Oberlin College Libraries
const PERPAGE     = 100;

// Days forward to ingest (rolling window)
const WINDOW_DAYS = 60;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFingerprint(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function windowEnd() {
  const d = new Date();
  d.setDate(d.getDate() + WINDOW_DAYS);
  return d;
}

/** Strip HTML tags and decode common entities */
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse "2026-04-30 15:30:00" → ISO 8601 */
function libcalToIso(str) {
  if (!str) return null;
  // LibCal datetimes are Eastern time
  return str.replace(" ", "T") + "-04:00"; // EDT; adjust if needed
}

// ─── API fetch (with retry) ───────────────────────────────────────────────────

async function fetchPage(page) {
  const url =
    `${LIBCAL_API}?c=${CALENDAR_ID}&date=0000-00-00&perpage=${PERPAGE}&page=${page}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "oberlin-libcal-sync-bot/1.0",
          "Accept":     "application/json",
          "Referer":    "https://oberlin.libcal.com/calendar/events",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.warn(`  ⚠ Attempt ${attempt} failed (${err.message}) — retrying…`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

async function fetchAllEvents() {
  const events = [];
  let page = 1;
  while (true) {
    console.log(`  Fetching page ${page}…`);
    const data = await fetchPage(page);
    const results = data.results || [];
    events.push(...results);
    const total = data.total_results || 0;
    console.log(`  Page ${page}: ${results.length} events (total: ${total})`);
    if (events.length >= total || results.length < PERPAGE) break;
    page++;
  }
  return events;
}

// ─── Main ingester ────────────────────────────────────────────────────────────

export async function runIngester() {
  const now    = new Date();
  const cutoff = windowEnd();
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`→ Oberlin LibCal ingester`);
  console.log(`  Window: now → ${cutoffStr}`);

  const rawEvents = await fetchAllEvents();
  console.log(`  Total fetched: ${rawEvents.length} events`);

  const stagedEvents = [];
  const candidates   = [];

  for (const ev of rawEvents) {
    // startdt: "2026-04-30 15:30:00"
    const startStr = ev.startdt || "";
    const endStr   = ev.enddt   || "";

    if (!startStr) continue;

    const startDate = startStr.slice(0, 10); // "2026-04-30"
    const startTs   = new Date(startStr.replace(" ", "T")); // parse as local for comparison
    if (startTs < now || startDate > cutoffStr) continue; // skip past or too far future

    const startISO = libcalToIso(startStr);
    const endISO   = libcalToIso(endStr) || null;

    const rawDesc  = stripHtml(ev.description || "");
    const shortDesc = ev.shortdesc || rawDesc.slice(0, 200);
    const location  = ev.location  || SOURCE.default_location;
    const isOnline  = !!(ev.online_event);
    const photoUrl  = ev.featured_image || null;

    // Categories: array of strings like ["Books & Literature","Free Events"]
    const categories = Array.isArray(ev.categories) ? ev.categories : [];

    const fingerprint = makeFingerprint([SOURCE.id, String(ev.id), startDate]);

    const staged = {
      title:                   (ev.title || "Untitled Event").slice(0, 60),
      organizational_sponsor:  SOURCE.source_name,
      start_datetime:          startISO,
      end_datetime:            endISO,
      location_type:           isOnline ? "Online" : "In-Person",
      location_or_address:     isOnline ? "" : location,
      event_link:              ev.url || SOURCE.listing_url,
      short_description:       shortDesc.slice(0, 200),
      extended_description:    rawDesc.slice(0, 1000),
      registration_cost:       ev.registration_cost || "",
      _photoUrl:               photoUrl,
      all_day:                 !!ev.all_day,

      source_id:               SOURCE.id,
      source_name:             SOURCE.source_name,
      adapter_key:             SOURCE.adapter_key,
      source_event_url:        ev.url || SOURCE.listing_url,
      listing_url:             SOURCE.listing_url,
      contact_email:           "frankkusiap@gmail.com",

      categories,
      libcal_event_id:         String(ev.id),

      is_duplicate:            null,
      duplicate_match_url:     null,
      duplicate_reason:        null,
      confidence:              0.9,
      review_status:           "pending",

      raw_payload: {
        libcal_id:    ev.id,
        title:        ev.title,
        startdt:      ev.startdt,
        enddt:        ev.enddt,
        location:     ev.location,
        categories,
        online_event: ev.online_event,
      },
    };

    stagedEvents.push(staged);
    candidates.push({
      external_event_id: String(ev.id),
      event_url:         ev.url || SOURCE.listing_url,
      title_hint:        staged.title,
      fingerprint,
      raw_payload: { adapter: SOURCE.adapter_key, libcal_id: String(ev.id) },
    });

    console.log(
      `  📚 ${staged.title}  [${startDate}${ev.all_day ? " all-day" : ""}]  ${location}`
    );
  }

  console.log("\n══════════════════════════════════════════");
  console.log(`  Oberlin LibCal — ${SOURCE.adapter_key}`);
  console.log("══════════════════════════════════════════");
  console.log(`  Events in window : ${stagedEvents.length}`);
  if (stagedEvents.length > 0) {
    console.log("\n  Sample:");
    for (const e of stagedEvents.slice(0, 5)) {
      console.log(`\n  ┌─ 📚 ${e.title}`);
      console.log(`  │  Start:  ${e.start_datetime}`);
      console.log(`  │  Loc:    ${e.location_or_address.slice(0, 60)}`);
      console.log(`  └─ Desc:   ${(e.short_description || "").slice(0, 80)}`);
    }
  }
  console.log("══════════════════════════════════════════\n");

  return {
    candidates,
    stagedEvents,
    summary: { adapter: SOURCE.adapter_key, eligible_events: stagedEvents.length },
  };
}

// Run directly when called as a standalone script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runIngester().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
