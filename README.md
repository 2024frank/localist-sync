# Oberlin Community Calendar Unification

An AI-assisted system that aggregates events from every major Oberlin source,
filters them through a three-agent AI pipeline, and lets a human reviewer
approve them before they appear on the
[Oberlin Community Calendar](https://oberlin.communityhub.cloud).

---

## The Problem

Event information in Oberlin is scattered across a dozen different platforms.
Oberlin College, FAVA, AMAM, the Apollo Theatre, the public library, and local
organizations each publish their own calendar. There is no single place where
students, faculty, staff, and Oberlin residents can see everything happening in
the community.

---

## The Solution

Automated sync pipelines pull events from every source on a schedule, run each
event through three Gemini-powered AI agents (duplicate check, public-access
filter, description cleaner), and queue survivors for human review in a
custom dashboard. One click approves an event and posts it to CommunityHub.
Events are **never** posted automatically — a human must approve every one.

---

## Who Is Involved

| Person | Role |
|---|---|
| Frank Kusi Appiah | Developer, project lead (Oberlin College, Class of 2027) |
| Prof. John Petersen | Faculty advisor |

---

## Active Sources

| Source | Method | Schedule | Notes |
|---|---|---|---|
| **Oberlin Localist** | REST API (paginated) | Hourly | Oberlin College's official calendar — up to 365 days ahead |
| **Allen Memorial Art Museum** | Playwright scrape | Hourly | Exhibition and event pages on `amam.oberlin.edu` |
| **Oberlin Heritage Center** | Playwright scrape | Hourly | Tours, workshops, and community events |
| **Apollo Theatre** | Cleveland Cinemas API | Hourly | Movies playing next 14 days — one event per film, all showtimes as sessions |
| **Oberlin College Libraries** | LibCal AJAX API | Every 6 h | Author talks, concerts, exhibitions — 60-day rolling window |

---

## AI Pipeline

Every event flows through three agents in sequence. Gemini (`gemini-2.5-flash`)
powers all three.

```
Source Calendar
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. Duplicate Agent                                             │
│     Layer 1: date window check (±1 day)                        │
│     Layer 2: Jaccard title similarity (≥ 0.35 threshold)       │
│     Layer 3: location word overlap guard                        │
│     Layer 4: Gemini confirms at ≥ 70% confidence               │
│     Layer 5: Firestore within-queue guard (already pending?)    │
│     → Duplicate → Duplicates tab (not posted)                   │
└─────────────────────────────────────────────────────────────────┘
      │ (not duplicate)
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Public Agent                                                │
│     Gemini answers: can any Oberlin resident attend with        │
│     no college affiliation?                                     │
│     → Private at ≥ 75% confidence → Rejected tab               │
└─────────────────────────────────────────────────────────────────┘
      │ (public)
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Writer Agent                                                │
│     Gemini cleans the description:                             │
│       - Strips all URLs and stream links                        │
│       - Summarizes to ≤ 200 chars (short) / ≤ 1000 (extended)  │
│       - Ends at a sentence boundary                             │
│     Builds the full CommunityHub API payload                    │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  Review Queue (dashboard)                                       │
│     Reviewer sees: original event │ Writer's cleaned version   │
│     Reviewer can edit any field                                 │
│     Approve → posted to CommunityHub → awaits their moderation  │
│     Reject  → counted in analytics                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dashboard

Deployed at **`https://ai-microgrant-research-oberlin.vercel.app`**

Sign in with an authorized Google account. Only `frankkusiap@gmail.com` has
admin access by default; other accounts can be added from the Users page.

| Page | Purpose |
|---|---|
| **Overview** | Pipeline stats per source: analyzed, queued, skipped, last run time |
| **Review Queue** | Side-by-side original vs Writer's version — edit, then approve or reject |
| **Rejected** | Events blocked by AI agents (private or duplicate) |
| **Sources** | Trigger a sync run manually; view last run status and GitHub Actions link |
| **Duplicates** | Flagged pairs side-by-side — confirm or override |
| **AI Analysis** | Gemini agent performance metrics |
| **Users** | Add / remove authorized Google accounts (admin only) |

### Review Queue features

- **Amber border** on any field = unsaved edit in progress
- **Save Changes** button at bottom locks in edits to Firestore before approving
- **Contact Email datalist** — click the field to pick `frankkusiap@gmail.com`
  or `fkusiapp@oberlin.edu` without typing
- **Bulk approve** — check multiple events, then "Approve N selected"
- **Auto-expire** — events whose start time has passed are auto-rejected on load

---

## Repository Structure

```
AI-Microgrant-Research-Oberlin/
│
├── ingest-*.js              # One ingester per source — pure data fetch + stage
│   ├── ingest-amam.js
│   ├── ingest-apollo-theatre.js
│   ├── ingest-heritage-center.js
│   ├── ingest-oberlin-libcal.js
│   └── (+ city-of-oberlin, experience-oberlin, fava, oberlin-library)
│
├── sync-*.js                # One sync script per source — runs ingester then pipeline
│   ├── sync-amam.js
│   ├── sync-apollo-theatre.js
│   ├── sync-heritage-center.js
│   ├── sync-oberlin-libcal.js
│   └── (+ others)
│
├── sync.js                  # Localist-specific sync (older, self-contained)
├── pipeline.js              # Shared pipeline used by AMAM and Heritage Center
│
├── lib/
│   └── duplicate-agent.js   # Shared duplicate-detection logic (all 5 layers)
│
├── .github/workflows/
│   ├── sync.yml             # Localist — hourly cron + workflow_dispatch
│   ├── sync-amam.yml        # AMAM — hourly
│   ├── sync-apollo-theatre.yml  # Apollo — hourly
│   ├── sync-heritage-center.yml # Heritage Center — hourly
│   └── sync-oberlin-libcal.yml  # LibCal — every 6 hours
│
└── dashboard/               # Next.js app (deployed on Vercel)
    └── src/app/
        ├── dashboard/       # All dashboard pages
        │   ├── review/      # Review Queue
        │   ├── sources/     # Source management + manual trigger
        │   ├── duplicates/  # Duplicate pair review
        │   ├── rejected/    # Rejected events
        │   ├── ai-analysis/ # Agent metrics
        │   └── users/       # User management
        └── api/
            ├── push-event/  # POST → CommunityHub API
            ├── sync/trigger/ # GET status / POST dispatch / DELETE cancel
            └── admin/       # User management + data clearing
```

---

## Technical Reference

### Firestore Collections

| Collection | Purpose |
|---|---|
| `review_queue` | Pending / approved / rejected events — one doc per event |
| `rejected` | Events blocked by AI (reason: `private` or `duplicate`) |
| `duplicates` | Flagged duplicate pairs awaiting human confirmation |
| `syncs` | Per-source pipeline run statistics (queued, skipped, analyzed…) |

### CommunityHub Field Mapping

| CH Field | Source |
|---|---|
| `title` | Event title (max 60 chars) |
| `description` | Gemini-cleaned short description (max 200 chars) |
| `extendedDescription` | Gemini-cleaned full description (max 1000 chars) |
| `email` / `contactEmail` | Always `frankkusiap@gmail.com` — never the source event's email |
| `phone` | Contact phone from source, or empty |
| `website` | Source event URL |
| `sponsors` | Department / organization name from source |
| `postTypeId` | Mapped from event type keywords (see table below) |
| `sessions[].startTime` | Unix timestamp |
| `sessions[].endTime` | Unix timestamp |
| `locationType` | `ph2` (in-person) / `on` (online) / `bo` (hybrid) |
| `location` | Address or venue name |
| `_photoUrl` | Image URL — uploaded by push-event route at approval time |

### Event Type → Category ID

| Keywords | Category ID |
|---|---|
| lecture, talk, presentation, seminar, conference, symposium | `6` |
| music, concert | `8` |
| performance, theatre, theater, dance, film, movie, screening | `9` |
| workshop, class | `7` |
| exhibit, exhibition, gallery, display | `2` |
| festival, fair, celebration | `3` |
| tour, open house | `4` |
| sport, game, recreation | `12` |
| networking | `13` |
| *(anything else)* | `89` (Other) |

### GitHub Secrets Required

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Admin SDK credentials (JSON, base64 optional) |
| `GEMINI_API_KEY` | Google Gemini API key — powers all three AI agents |
| `GITHUB_PAT` | Personal access token for dashboard → workflow_dispatch trigger |

### Triggering a Sync

Syncs run automatically on their cron schedule. To run one immediately:

1. **Dashboard** → Sources → click **Start** next to any source
2. **GitHub** → Actions → pick the workflow → **Run workflow**

---

## Duplicate Detection (5-layer algorithm)

Implemented in `lib/duplicate-agent.js`, shared across all sync scripts.

| Layer | Method | Cost |
|---|---|---|
| 1 | Date window: events must be within ±1 calendar day | ⚡ free |
| 2 | Jaccard title similarity ≥ 0.35 on words ≥ 4 chars | ⚡ free |
| 3 | Location word overlap (at least one 4-char word in common) | ⚡ free |
| 4 | Gemini AI confirmation at ≥ 70% confidence | 🐢 API call |
| 5 | Firestore within-queue guard (same slug already pending) | 🐢 DB read |

Only events that pass layers 1–3 are sent to Gemini. Tunable constants
(`TITLE_JACCARD_THRESHOLD`, `DATE_WINDOW_DAYS`, `MIN_GEMINI_CONFIDENCE`) live
at the top of `lib/duplicate-agent.js`.

---

## Source-Specific Notes

### Apollo Theatre
- Uses the **Cleveland Cinemas internal box-office API** — no browser needed
- One event per movie; each showtime slot becomes its own `session` object
- 14-day rolling window (posts go out Fridays; two weeks covers next post + the one after)
- `fetchSchedule` is non-fatal — if the schedule API fails on GitHub Actions IPs
  (ECONNRESET is common), it falls back to 7 PM ET sessions on each playing date
- Poster images: prefers wide hero banner → locale poster → fallback

### Oberlin College Libraries (LibCal)
- Uses the **LibCal AJAX JSON API** at `oberlin.libcal.com/ajax/calendar/list`
- Calendar ID: `10805` (Oberlin College Libraries Events)
- 60-day rolling window; paginates automatically if more than 100 events
- `featured_image` field provides CloudFront image URLs — no auth needed
- Public Agent defaults to PUBLIC for library events (most are open to all)

### Allen Memorial Art Museum / Heritage Center
- Both use **Playwright** (headless Chromium) to scrape event pages
- AMAM mirrors its exhibitions alongside the Allen Art Museum's shows
- Heritage Center: tours, workshops, walking tours — most require advance booking

---

## What's Next

- FAVA Gallery ingester (selector fix for `/classes/YYYY/MM/DD/…` pages)
- City of Oberlin events (mostly government meetings — needs user decision)
- Events page in dashboard showing all approved/posted events with CH links
- AI agent accuracy feedback loop (track which Gemini verdicts reviewers override)
- Vercel scheduled function to auto-expire stale queue items server-side
