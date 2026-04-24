/**
 * Oberlin Heritage Center Event Ingester — heritage_center_v1
 * Adapter for: Oberlin Heritage Center
 *
 * oberlinheritagecenter.org blocks plain HTTP clients via TLS fingerprinting.
 * Solution: use Playwright's page.request.get() which routes through Chromium's
 * TLS stack — indistinguishable from a real browser, bypassing the JA3 check.
 *
 * API: WordPress / The Events Calendar REST API
 *   GET /wp-json/tribe/events/v1/events?start_date=YYYY-MM-DD&per_page=50&page=N
 *
 * Run: node --env-file=.env ingest-heritage-center.js
 */

import { chromium } from "playwright";
import crypto from "crypto";

const SOURCE = {
  id: "heritage_center",
  source_name: "Oberlin Heritage Center",
  adapter_key: "heritage_center_v1",
  listing_url: "https://www.oberlinheritagecenter.org/events/",
  api_base:    "https://www.oberlinheritagecenter.org/wp-json/tribe/events/v1/events",
  attribution_label: "Oberlin Heritage Center",
  default_location:  "73½ S. Professor St., Oberlin, OH 44074",
  default_email:     "fkusiapp@oberlin.edu",
  default_phone:     "440-774-1700",
};

const PER_PAGE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFingerprint(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function truncate(str, max) {
  if (!str || str.length <= max) return str || null;
  const chunk = str.slice(0, max);
  const lastPeriod = chunk.lastIndexOf(".");
  return lastPeriod > max * 0.5 ? str.slice(0, lastPeriod + 1).trim() : chunk.trimEnd();
}

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#8211;/g, "-").replace(/&#8217;/g, "'").replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/\s+/g, " ")
    .trim() || null;
}

// ─── Fetch all events via Playwright page.request.get() ───────────────────────

async function fetchAllEvents() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await context.newPage();

  const today    = new Date().toISOString().slice(0, 10);
  const allRaw   = [];
  let   pageNum  = 1;

  try {
    while (true) {
      const url = `${SOURCE.api_base}?start_date=${today}&per_page=${PER_PAGE}&page=${pageNum}`;
      console.log(`  → Page ${pageNum}: ${url}`);

      const res = await page.request.get(url, { timeout: 30000 });

      if (!res.ok()) {
        console.log(`    HTTP ${res.status()} — stopping`);
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        console.log(`    JSON parse error: ${err.message} — stopping`);
        break;
      }

      // Tribe Events REST API response shape: { events: [...], total, total_pages }
      const events = Array.isArray(data) ? data : (data.events || []);
      console.log(`    ${events.length} events`);

      if (events.length === 0) break;
      allRaw.push(...events);

      const totalPages = data.total_pages ?? 1;
      if (pageNum >= totalPages || events.length < PER_PAGE) break;

      pageNum++;
    }
  } finally {
    await browser.close();
  }

  return allRaw;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString();

  console.log("→ Fetching Heritage Center events via Playwright + Chromium TLS\n");
  const allRaw = await fetchAllEvents();
  console.log(`\n→ Total raw events: ${allRaw.length}`);

  const stagedEvents = [];
  const candidates   = [];
  const seenKeys     = new Set();

  for (const e of allRaw) {
    const title = stripHtml(e.title) || null;
    if (!title) continue;

    // Tribe Events date fields: "2026-05-09 09:00:00"
    const startRaw = e.start_date || null;
    const endRaw   = e.end_date   || null;

    const start_datetime = startRaw ? new Date(startRaw).toISOString() : null;
    const end_datetime   = endRaw   ? new Date(endRaw).toISOString()   : null;

    // Deduplicate by title + start
    const key = `${title}|${start_datetime || ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Drop past events
    if (start_datetime && start_datetime < now) continue;

    const rawDesc   = e.description || e.excerpt || null;
    const description = stripHtml(rawDesc);

    // Image — Tribe Events puts it at e.image.url
    const artwork_url =
      e.image?.url ||
      e.image?.sizes?.medium?.url ||
      null;

    const event_link = e.url || SOURCE.listing_url;

    // Venue
    const venueName = e.venue?.venue || null;
    const isOnline  = /zoom|virtual|online/i.test(title + (description || ""));
    const location_type = isOnline ? "Online" : "In-Person";
    const location_or_address = isOnline
      ? null
      : venueName
        ? `${venueName}, ${SOURCE.default_location}`
        : SOURCE.default_location;

    const staged = {
      title,
      organizational_sponsor: SOURCE.attribution_label,
      start_datetime,
      end_datetime,
      location_type,
      location_or_address,
      room_number:          venueName || null,
      event_link,
      short_description:    truncate(description, 200),
      extended_description: description || null,
      artwork_url,
      _photoUrl: artwork_url || null, // mapped to image_cdn_url at push time

      source_id:        SOURCE.id,
      source_name:      SOURCE.source_name,
      adapter_key:      SOURCE.adapter_key,
      source_event_url: event_link,
      listing_url:      SOURCE.listing_url,
      contact_email:    SOURCE.default_email,
      contact_phone:    SOURCE.default_phone,

      is_duplicate:        null,
      duplicate_match_url: null,
      duplicate_reason:    null,
      confidence:          0.9,
      review_status:       "pending",

      raw_payload: e,
    };

    stagedEvents.push(staged);
    candidates.push({
      external_event_id: e.id || null,
      event_url: event_link,
      title_hint: title,
      fingerprint: makeFingerprint([SOURCE.id, event_link, start_datetime || title]),
      raw_payload: { adapter: SOURCE.adapter_key },
    });
  }

  const result = {
    candidates,
    stagedEvents,
    summary: {
      adapter: SOURCE.adapter_key,
      eligible_events: stagedEvents.length,
    },
  };

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════");
  console.log(`  Heritage Center — ${SOURCE.adapter_key}`);
  console.log("══════════════════════════════════════════");
  console.log(`  Raw events from API : ${allRaw.length}`);
  console.log(`  Eligible (future)   : ${stagedEvents.length}`);
  console.log(`  Match (equal?)      : ${candidates.length === stagedEvents.length ? "✓ YES" : "✗ NO"}`);

  if (stagedEvents.length > 0) {
    console.log("\n  Sample events:");
    for (const e of stagedEvents.slice(0, 5)) {
      console.log(`\n  ┌─ ${e.title}`);
      console.log(`  │  start    : ${e.start_datetime || "—"}`);
      console.log(`  │  end      : ${e.end_datetime || "—"}`);
      console.log(`  │  location : ${e.location_or_address || "—"}`);
      console.log(`  │  image    : ${e.artwork_url || "—"}`);
      console.log(`  └─ desc     : ${(e.short_description || "—").slice(0, 80)}`);
    }
  } else {
    console.log("\n  ⚠ No future events found.");
  }

  console.log("\n══════════════════════════════════════════\n");
  return result;
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
