/**
 * AMAM Event Ingester — amam_camoufox_v1
 * Adapter for: Allen Memorial Art Museum (AMAM)
 *
 * Collects from THREE sections:
 *   1. /exhibitions-events/events          — one-time events (all pages)
 *   2. /exhibitions-events/exhibitions/current    — exhibitions currently on view
 *   3. /exhibitions-events/exhibitions/upcoming   — upcoming exhibitions (paginated)
 *
 * For each URL found, visits the detail page to extract title, date,
 * gallery/room, description, and image.
 *
 * Run: node --env-file=.env ingest-amam.js
 */

import { chromium } from "playwright";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { runPipeline } from "./pipeline.js";

const SOURCE = {
  id: "amam",
  source_name: "Allen Memorial Art Museum (AMAM)",
  adapter_key: "amam_camoufox_v1",
  listing_url: "https://amam.oberlin.edu/exhibitions-events/events",
  attribution_label: "Allen Memorial Art Museum",
  default_location: "87 N. Main St., Oberlin, OH 44074",
  default_email: "fkusiapp@oberlin.edu",
  default_phone: "440.775.8665",
};

const BASE = "https://amam.oberlin.edu";

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

/**
 * Parse date line, e.g.:
 *   "Friday, May 8, 2026 at 5:30 p.m. - 7:30 p.m."
 *   "On view through August 19, 2026"
 *   "On view beginning May 26, 2026"
 *   "On View Summer 2026"        ← season only, we pick a rough date
 */
function parseDateLine(line) {
  if (!line) return { start_datetime: null, end_datetime: null };

  const norm = line
    .replace(/\bAT\b/gi, "")
    .replace(/P\.M\./gi, "PM")
    .replace(/A\.M\./gi, "AM")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  // "DAY, MONTH DD, YYYY HH:MM PM - HH:MM PM"
  const fullRe =
    /(?:[A-Z]+,\s+)?([A-Z]+ \d{1,2},?\s+\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)(?:\s*-\s*(\d{1,2}:\d{2}\s*[AP]M))?/i;
  const m = norm.match(fullRe);
  if (m) {
    const base = m[1].replace(/,/, "");
    const start = new Date(`${base} ${m[2]}`);
    const end = m[3] ? new Date(`${base} ${m[3]}`) : null;
    if (!isNaN(start.getTime())) {
      return {
        start_datetime: start.toISOString(),
        end_datetime: end && !isNaN(end.getTime()) ? end.toISOString() : null,
      };
    }
  }

  // "MONTH DD, YYYY" anywhere in line
  const dateRe = /([A-Z]+ \d{1,2},?\s+\d{4})/i;
  const m2 = norm.match(dateRe);
  if (m2) {
    const d = new Date(m2[1].replace(/,/, ""));
    if (!isNaN(d.getTime())) {
      // For exhibitions: "through X" means end date; "beginning X" means start date
      if (/through|closing/i.test(norm)) {
        return { start_datetime: null, end_datetime: d.toISOString() };
      }
      return { start_datetime: d.toISOString(), end_datetime: null };
    }
  }

  // Season fallback: "Summer 2026" → June 21, "Fall 2026" → Sep 22, etc.
  const seasonRe = /\b(Spring|Summer|Fall|Autumn|Winter)\s+(\d{4})\b/i;
  const ms = norm.match(seasonRe);
  if (ms) {
    const seasonMap = { spring: "03-20", summer: "06-21", fall: "09-22", autumn: "09-22", winter: "12-21" };
    const key = ms[1].toLowerCase();
    const d = new Date(`${ms[2]}-${seasonMap[key]}`);
    if (!isNaN(d.getTime())) {
      return { start_datetime: d.toISOString(), end_datetime: null };
    }
  }

  return { start_datetime: null, end_datetime: null };
}

// ─── Collect event URLs from the /events listing ──────────────────────────────

async function collectEventUrls(page) {
  console.log("→ Events listing:", SOURCE.listing_url);
  await page.goto(SOURCE.listing_url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  const hrefs = await page.evaluate(() => {
    const links = [...document.querySelectorAll("a[href*='/events/']")]
      .filter(a => /\/events\/\d{4}\/\d{2}\/\d{2}\//.test(a.href));
    return [...new Set(links.map(a => a.href))];
  });

  console.log(`   Found ${hrefs.length} event URLs`);
  return hrefs;
}

// ─── Collect exhibition URLs from current + upcoming (paginated) ──────────────

async function collectExhibitionUrls(page) {
  const allHrefs = new Set();

  const sections = [
    `${BASE}/exhibitions-events/exhibitions/current`,
    `${BASE}/exhibitions-events/exhibitions/upcoming`,
  ];

  for (const sectionUrl of sections) {
    let pageNum = 0;
    while (true) {
      const url = pageNum === 0 ? sectionUrl : `${sectionUrl}?page=${pageNum}`;
      console.log(`→ Exhibitions page: ${url}`);
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(2000);

      const hrefs = await page.evaluate(() => {
        const links = [...document.querySelectorAll("a[href*='/exhibitions/']")]
          .filter(a => /\/exhibitions\/\d{4}\/\d{2}\/\d{2}\//.test(a.href));
        return [...new Set(links.map(a => a.href))];
      });

      const prevSize = allHrefs.size;
      hrefs.forEach(h => allHrefs.add(h));
      const added = allHrefs.size - prevSize;
      console.log(`   Found ${hrefs.length} exhibition URLs (${added} new, total: ${allHrefs.size})`);

      // Stop if this page added nothing new (reached end of pagination)
      if (added === 0) break;
      pageNum++;
      if (pageNum > 15) break; // safety cap
    }
  }

  return [...allHrefs];
}

// ─── Scrape an individual event or exhibition detail page ─────────────────────

async function scrapeDetail(page, url, kind) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(700);

    return await page.evaluate(({ eventUrl, kind }) => {
      const title = document.querySelector("h1")?.textContent?.trim() || null;
      if (!title) return null;

      const mainText = (document.querySelector("main") || document.body)?.innerText || "";
      const lines = mainText.split("\n").map(l => l.trim()).filter(Boolean);

      const MONTHS = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
      const SEASONS = /\b(Spring|Summer|Fall|Autumn|Winter)\b/i;
      const titleIdx = lines.findIndex(l => l.startsWith(title.slice(0, 20)));

      // Date line: first line after title matching a date/season pattern
      let dateLine = null;
      let room = null;
      for (let i = Math.max(0, titleIdx - 3); i < Math.min(titleIdx + 10, lines.length); i++) {
        const l = lines[i];
        if (!dateLine && (MONTHS.test(l) || SEASONS.test(l)) && /\d/.test(l)) {
          dateLine = l;
        }
        // Room/gallery: short line with "Gallery", "Ambulatory", "Hallway", "Stern", "Ripin"
        if (!room && /gallery|ambulatory|hallway|stern|ripin|johnson/i.test(l) && l.length < 60) {
          room = l;
        }
      }

      // Description: lines after the date, before boilerplate
      const descStart = dateLine
        ? lines.findIndex(l => l === dateLine) + 1
        : titleIdx + 1;
      const descLines = [];
      for (let i = descStart; i < lines.length && descLines.length < 8; i++) {
        const l = lines[i];
        if (/^(SHARE|FOLLOW|BACK|CONTACT|HOME|©|SUBSCRIBE|JOIN|LEARN MORE|BECOME|VIEW ALL)/i.test(l)) break;
        if (l.length > 20) descLines.push(l);
      }
      const description = descLines.join(" ").trim() || null;

      // Image: first non-logo, non-tiny img
      const img = [...document.querySelectorAll("img")]
        .find(i => i.src && !i.src.includes("logo") && !i.src.includes("data:") && !i.src.includes("accred"));
      const imgSrc = img?.src || null;

      return { title, dateLine, room, description, imgSrc, eventUrl, kind };
    }, { eventUrl: url, kind });
  } catch (err) {
    console.warn(`  ⚠ Could not scrape ${url}: ${err.message}`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runIngester() {
  const browser = await chromium.launch({ headless: true });
  const now = new Date().toISOString();
  const stagedEvents = [];
  const candidates = [];

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
    });
    const page = await context.newPage();

    // ── Collect all URLs ────────────────────────────────────────────────────
    const eventUrls       = await collectEventUrls(page);
    const exhibitionUrls  = await collectExhibitionUrls(page);

    const allItems = [
      ...eventUrls.map(u => ({ url: u, kind: "event" })),
      ...exhibitionUrls.map(u => ({ url: u, kind: "exhibition" })),
    ];

    // Deduplicate
    const seen = new Set();
    const unique = allItems.filter(({ url }) => { if (seen.has(url)) return false; seen.add(url); return true; });

    console.log(`\n→ Scraping ${unique.length} detail pages (${eventUrls.length} events + ${exhibitionUrls.length} exhibitions)…\n`);

    for (let i = 0; i < unique.length; i++) {
      const { url, kind } = unique[i];
      const detail = await scrapeDetail(page, url, kind);
      if (!detail || !detail.title) continue;

      const { start_datetime, end_datetime } = parseDateLine(detail.dateLine);

      // For exhibitions: if we only got an end_datetime ("on view through X"),
      // use today as start so we include currently-running shows
      const effectiveStart = start_datetime ||
        (end_datetime ? new Date().toISOString() : null);
      const effectiveEnd   = end_datetime;

      // Drop if clearly in the past (end date passed)
      if (effectiveEnd && effectiveEnd < now) continue;
      // Drop events (not exhibitions) if start is in the past
      if (kind === "event" && effectiveStart && effectiveStart < now) continue;

      const isOnline = /zoom|virtual|online/i.test(detail.title + (detail.description || ""));
      const location_type = isOnline ? "Online" : "In-Person";

      // For exhibitions: append the gallery room to the address
      const locationStr = detail.room
        ? `${detail.room}, ${SOURCE.default_location}`
        : SOURCE.default_location;
      const location_or_address = isOnline ? null : locationStr;

      const staged = {
        title: detail.title,
        organizational_sponsor: SOURCE.attribution_label,
        start_datetime: effectiveStart,
        end_datetime: effectiveEnd,
        location_type,
        location_or_address,
        room_number: detail.room || null,
        event_link: url,
        short_description: truncate(detail.description, 200),
        extended_description: detail.description || null,
        artwork_url: detail.imgSrc || null,
        _photoUrl: detail.imgSrc || null, // mapped to image_cdn_url at push time

        source_id: SOURCE.id,
        source_name: SOURCE.source_name,
        adapter_key: SOURCE.adapter_key,
        source_event_url: url,
        listing_url: SOURCE.listing_url,
        contact_email: SOURCE.default_email,
        contact_phone: SOURCE.default_phone,

        is_duplicate: null,
        duplicate_match_url: null,
        duplicate_reason: null,
        confidence: kind === "event" ? 0.92 : 0.85,
        review_status: "pending",

        raw_payload: detail,
      };

      stagedEvents.push(staged);
      candidates.push({
        external_event_id: null,
        event_url: url,
        title_hint: detail.title,
        fingerprint: makeFingerprint([SOURCE.id, url, effectiveStart || ""]),
        raw_payload: { adapter: SOURCE.adapter_key, kind },
      });

      const icon = kind === "exhibition" ? "🖼" : "📅";
      process.stdout.write(`  [${i + 1}/${unique.length}] ${icon} ${detail.title.slice(0, 55)}\n`);
    }
  } finally {
    await browser.close();
  }

  const result = {
    candidates,
    stagedEvents,
    summary: {
      adapter: SOURCE.adapter_key,
      eligible_events: stagedEvents.length,
    },
  };

  const eventCount = stagedEvents.filter(e => e.raw_payload.kind === "event").length;
  const exhibCount = stagedEvents.filter(e => e.raw_payload.kind === "exhibition").length;

  console.log("\n══════════════════════════════════════════");
  console.log(`  AMAM Ingester — ${SOURCE.adapter_key}`);
  console.log("══════════════════════════════════════════");
  console.log(`  One-time events    : ${eventCount}`);
  console.log(`  Exhibitions        : ${exhibCount}`);
  console.log(`  Total eligible     : ${stagedEvents.length}`);
  console.log(`  Match (equal?)     : ${candidates.length === stagedEvents.length ? "✓ YES" : "✗ NO"}`);

  if (stagedEvents.length > 0) {
    console.log("\n  Sample:");
    for (const e of stagedEvents.slice(0, 4)) {
      const icon = e.raw_payload.kind === "exhibition" ? "🖼" : "📅";
      console.log(`\n  ┌─ ${icon} ${e.title}`);
      console.log(`  │  start       : ${e.start_datetime || "—"}`);
      console.log(`  │  end         : ${e.end_datetime || "—"}`);
      console.log(`  │  room        : ${e.room_number || "—"}`);
      console.log(`  │  event_link  : ${e.event_link}`);
      console.log(`  └─ desc        : ${(e.short_description || "—").slice(0, 80)}`);
    }
  }

  console.log("\n══════════════════════════════════════════\n");
  return result;
}

// Run directly when called as a standalone script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { stagedEvents, candidates } = await runIngester();
  await runPipeline(
    stagedEvents.map((e, i) => ({ ...e, fingerprint: candidates[i]?.fingerprint })),
    "amam",
    "Allen Memorial Art Museum (AMAM)"
  );
}
