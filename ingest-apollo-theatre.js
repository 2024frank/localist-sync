/**
 * Apollo Theatre Event Ingester — apollo_theatre_v1
 * Adapter for: Apollo Theatre, Oberlin (19 East College Street)
 *
 * Uses the Cleveland Cinemas box-office API directly — no browser needed.
 *
 * Approach:
 *   1. GET /scheduledMovies?theaterId=X03GQ  → movie IDs + dates they play
 *   2. Filter to movies with at least one date in the NEXT 14 DAYS
 *      (We post every Friday; fetching 2 weeks out means next Friday's post
 *       AND the one after are both covered without stale events.)
 *   3. GET /movies?ids=...                   → title, synopsis, rating, poster, cast
 *   4. GET /schedule?from=...&to=...         → exact showtimes + ticket URLs per day
 *   5. One stagedEvent per movie — description lists all upcoming showtimes.
 *
 * Run: node --env-file=.env ingest-apollo-theatre.js
 */

import crypto from "crypto";
import { fileURLToPath } from "url";

const SOURCE = {
  id:               "apollo_theatre",
  source_name:      "Apollo Theatre",
  adapter_key:      "apollo_theatre_v1",
  listing_url:      "https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/",
  default_location: "19 East College Street, Oberlin, OH 44074",
  default_phone:    "440-774-3920",
};

const THEATER_ID = "X03GQ";
const THEATER_TZ = "America/New_York";
const BASE_API   = "https://www.clevelandcinemas.com/api/gatsby-source-boxofficeapi";
const MOVIE_PAGE = "https://www.clevelandcinemas.com/movies";

// How many days forward to fetch (covers this Friday's post + next Friday's post)
const WINDOW_DAYS = 14;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFingerprint(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function windowDates() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + WINDOW_DAYS);
  return { start, end };
}

function ymdToDate(ymd) {
  return new Date(ymd + "T00:00:00");
}

function fmtRuntime(seconds) {
  if (!seconds) return null;
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} hr${m > 0 ? ` ${m} min` : ""}` : `${m} min`;
}

function fmtShowtime(iso) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: THEATER_TZ,
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function ticketUrl(showtimesForMovie) {
  for (const slots of Object.values(showtimesForMovie)) {
    for (const slot of slots) {
      const link = slot.data?.ticketing?.find(t => t.provider === "default")?.urls?.[0];
      if (link) return link;
    }
  }
  return SOURCE.listing_url;
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(`${BASE_API}/${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return res.json();
}

async function fetchScheduledMovies() {
  return apiGet(`scheduledMovies?theaterId=${THEATER_ID}`);
}

async function fetchMovieDetails(ids) {
  if (!ids.length) return {};
  const idsParam = ids.map(id => `ids=${id}`).join("&");
  return apiGet(`movies?basic=false&castingLimit=5&${idsParam}`);
}

async function fetchSchedule(start, end) {
  const theaterParam = encodeURIComponent(JSON.stringify({ id: THEATER_ID, timeZone: THEATER_TZ }));
  const from = start.toISOString().slice(0, 19);
  const to   = end.toISOString().slice(0, 19);
  const data = await apiGet(`schedule?from=${from}&theaters=${theaterParam}&to=${to}`);
  return data?.[THEATER_ID]?.schedule || {};
}

// ─── Description builder ──────────────────────────────────────────────────────

function buildDescription(movie, showtimesForMovie, windowStart, windowEnd) {
  const synopsis  = movie.locale?.synopsis || movie.exhibitor?.synopsis || "";
  const runtime   = fmtRuntime(movie.runtime);
  const genres    = typeof movie.genres === "string" ? movie.genres : (movie.genres || []).join(", ");
  const rating    = movie.releases?.[0]?.rating?.certificate || "NR";
  const directors = (movie.directors?.nodes || [])
    .map(n => `${n.person?.firstName || ""} ${n.person?.lastName || ""}`.trim())
    .filter(Boolean).join(", ");
  const cast = (movie.cast?.nodes || []).slice(0, 3)
    .map(n => `${n.actor?.firstName || ""} ${n.actor?.lastName || ""}`.trim())
    .filter(Boolean).join(", ");

  // Collect all upcoming showtimes in window, sorted
  const windowStart_str = windowStart.toISOString().slice(0, 10);
  const windowEnd_str   = windowEnd.toISOString().slice(0, 10);
  const upcoming = [];
  for (const [date, slots] of Object.entries(showtimesForMovie)) {
    if (date < windowStart_str || date > windowEnd_str) continue;
    for (const slot of slots) {
      if (!slot.isExpired && slot.startsAt) upcoming.push(slot.startsAt);
    }
  }
  upcoming.sort();

  // Short description ≤ 200 chars
  const ratingRuntime = [rating, runtime, genres].filter(Boolean).join(" · ");
  const short = `${movie.title} (${ratingRuntime}) is showing at the Apollo Theatre in Oberlin.`.slice(0, 200);

  // Extended description
  const parts = [];
  if (synopsis) parts.push(synopsis);
  if (directors) parts.push(`Director: ${directors}`);
  if (cast)      parts.push(`Cast: ${cast}`);
  if (upcoming.length) {
    parts.push("\nUpcoming Showtimes:");
    upcoming.forEach(iso => parts.push(`  • ${fmtShowtime(iso)}`));
  }
  const extended = parts.filter(Boolean).join("\n").slice(0, 1000);

  return { short, extended };
}

// ─── Main ingester ────────────────────────────────────────────────────────────

export async function runIngester() {
  const { start: windowStart, end: windowEnd } = windowDates();
  const windowStart_str = windowStart.toISOString().slice(0, 10);
  const windowEnd_str   = windowEnd.toISOString().slice(0, 10);

  console.log(`→ Apollo Theatre ingester`);
  console.log(`  Window: ${windowStart_str} → ${windowEnd_str}`);

  // 1. Scheduled movies + their playing dates
  const sched        = await fetchScheduledMovies();
  const allIds       = sched.movieIds?.titleAsc || [];
  const scheduledDays = sched.scheduledDays || {};

  // 2. Filter: only movies with at least 1 day in the window
  const eligibleIds = allIds.filter(id => {
    const days = scheduledDays[id] || [];
    return days.some(d => d >= windowStart_str && d <= windowEnd_str);
  });

  console.log(`  Scheduled: ${allIds.length} movies total, ${eligibleIds.length} in window`);
  if (!eligibleIds.length) {
    return { candidates: [], stagedEvents: [], summary: { adapter: SOURCE.adapter_key, eligible_events: 0 } };
  }

  // 3. Movie details
  const moviesMap = await fetchMovieDetails(eligibleIds);
  console.log(`  Details fetched: ${Object.keys(moviesMap).length} entries`);

  // 4. Schedule for next 14 days
  const schedule = await fetchSchedule(windowStart, windowEnd);

  // 5. Build one stagedEvent per movie
  const stagedEvents = [];
  const candidates   = [];

  for (const movieId of eligibleIds) {
    // The movies API returns an object keyed by index, so find by m.id
    const movie = Object.values(moviesMap).find(m => String(m.id) === String(movieId));
    if (!movie) {
      console.warn(`  ⚠ No details for movie ID ${movieId} — skipping`);
      continue;
    }

    const showtimesForMovie = schedule[movieId] || {};
    const daysInWindow = (scheduledDays[movieId] || [])
      .filter(d => d >= windowStart_str && d <= windowEnd_str).sort();
    if (!daysInWindow.length) continue;

    // First upcoming non-expired slot on the first available day
    const firstDay   = daysInWindow[0];
    const firstSlots = (showtimesForMovie[firstDay] || []).filter(s => !s.isExpired);
    const firstSlot  = firstSlots[0];
    const startISO   = firstSlot?.startsAt || `${firstDay}T19:00:00`;
    const runtimeSec = movie.runtime || 7200;
    const endISO     = new Date(new Date(startISO).getTime() + runtimeSec * 1000).toISOString();

    const { short, extended } = buildDescription(movie, showtimesForMovie, windowStart, windowEnd);

    // Image priority: wide hero banner (landscape, best for CH) → portrait poster → still
    const poster  =
      movie.locale?.cmsAssets?.images?.find(i => i.type === "DEFAULT_HERO_IMAGE")?.url ||
      movie.locale?.poster?.url ||
      movie.poster ||
      movie.images?.[0]?.url ||
      null;
    const rating  = movie.releases?.[0]?.rating?.certificate || "NR";
    const genres  = typeof movie.genres === "string" ? movie.genres : (movie.genres || []).join(", ");
    const runtime = fmtRuntime(runtimeSec);
    const title   = (movie.title || "Untitled Film").slice(0, 60);
    const ticketLink = ticketUrl(showtimesForMovie) || SOURCE.listing_url;
    const fingerprint = makeFingerprint([SOURCE.id, String(movieId), firstDay]);

    const staged = {
      title,
      organizational_sponsor:  "Apollo Theatre",
      start_datetime:          startISO,
      end_datetime:            endISO,
      location_type:           "In-Person",
      location_or_address:     SOURCE.default_location,
      event_link:              ticketLink,
      short_description:       short,
      extended_description:    extended,
      _photoUrl:               poster,

      source_id:               SOURCE.id,
      source_name:             SOURCE.source_name,
      adapter_key:             SOURCE.adapter_key,
      source_event_url:        ticketLink,
      listing_url:             SOURCE.listing_url,
      contact_email:           "frankkusiap@gmail.com",
      contact_phone:           SOURCE.default_phone,

      // Cinema metadata — exposed so writer agent can tailor the posting
      movie_id:                String(movieId),
      mpaa_rating:             rating,
      runtime_display:         runtime,
      genres,
      playing_dates:           daysInWindow,
      first_showtime:          startISO,

      is_duplicate:            null,
      duplicate_match_url:     null,
      duplicate_reason:        null,
      confidence:              0.95,
      review_status:           "pending",

      raw_payload: {
        movieId: String(movieId),
        title,
        scheduledDays:    daysInWindow,
        showtimesForMovie,
      },
    };

    stagedEvents.push(staged);
    candidates.push({
      external_event_id: String(movieId),
      event_url:         ticketLink,
      title_hint:        title,
      fingerprint,
      raw_payload: { adapter: SOURCE.adapter_key, movieId: String(movieId) },
    });

    const dayRange = daysInWindow.length === 1
      ? daysInWindow[0]
      : `${daysInWindow[0]} → ${daysInWindow[daysInWindow.length - 1]}`;
    console.log(`  🎬 ${title} (${rating}${runtime ? ` · ${runtime}` : ""}) — ${dayRange}`);
  }

  console.log("\n══════════════════════════════════════════");
  console.log(`  Apollo Theatre — ${SOURCE.adapter_key}`);
  console.log("══════════════════════════════════════════");
  console.log(`  Movies in window : ${stagedEvents.length}`);
  if (stagedEvents.length > 0) {
    console.log("\n  Sample:");
    for (const e of stagedEvents.slice(0, 4)) {
      console.log(`\n  ┌─ 🎬 ${e.title}`);
      console.log(`  │  Rating:  ${e.mpaa_rating}  ·  ${e.runtime_display}`);
      console.log(`  │  Playing: ${e.playing_dates.join(", ")}`);
      console.log(`  │  Start:   ${e.first_showtime}`);
      console.log(`  └─ Desc:    ${(e.short_description || "").slice(0, 90)}`);
    }
  }
  console.log("══════════════════════════════════════════\n");

  return { candidates, stagedEvents, summary: { adapter: SOURCE.adapter_key, eligible_events: stagedEvents.length } };
}

// Run directly when called as a standalone script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runIngester().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
