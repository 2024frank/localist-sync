# Oberlin Community Calendar Unification

An AI-assisted project to bring all Oberlin community events into one place.

---

## The Problem

Event information in Oberlin is scattered. Oberlin College, FAVA, AMAM, the City of Oberlin, local businesses, and student organizations each manage their own calendar on their own platform. There is no single place where students, faculty, staff, and Oberlin residents can see everything happening in the community.

---

## The Goal

Build a system that automatically pulls events from every major Oberlin community source and unifies them on the [Oberlin Community Calendar](https://environmentaldashboard.org/calendar/?show-menu-bar=1) — one place for everyone. The system uses AI to detect and avoid posting the same event twice when it appears on multiple source calendars.

---

## Who Is Involved

| Person | Role |
|---|---|
| Frank Kusi Appiah | Developer, project lead (Oberlin College, Class of 2027) |
| Prof. John Petersen | Faculty advisor |

---

## What We Have Done So Far

### Localist to Community Calendar Sync

The first working pipeline automatically syncs all live, public events from Oberlin College's Localist calendar to the Oberlin Community Calendar.

Here is the full flow:

1. **GitHub Actions triggers the sync every hour** — no manual work needed, it just runs in the background on a schedule.

2. **Fetch events from Localist** — the script calls the Localist API (`calendar.oberlin.edu/api/2/events`) and pulls all upcoming live, public events up to 365 days ahead. The API returns results in pages of 100 so the script loops through every page until it has them all.

3. **Check for duplicates** — before doing anything with an event, the script checks `pushed_ids.json`, a file stored in the repo that tracks every Localist event ID that has already been posted. If the ID is in that file, the event is skipped entirely.

4. **Build the payload** — for each new event, the script maps the Localist fields to the format the Community Calendar API expects. This includes:
   - Title and description (truncated to fit the API limits)
   - Start and end times (converted to Unix timestamps)
   - Location and location type (in-person, virtual, or hybrid)
   - Contact email and phone number
   - Event category (mapped from Localist event type names to Community Calendar category IDs)
   - Sponsoring department
   - Event image (downloaded from Localist and converted to a base64 data URI so it transfers through the API)

5. **Post to the Community Calendar** — the script sends a POST request with the payload to the Community Calendar API. The event is created and appears on the calendar.

6. **Save the ID** — once an event is successfully posted, its Localist ID is added to `pushed_ids.json` and the file is committed back to the repo. This is what prevents duplicates on the next run.

We have successfully pushed 93+ Oberlin College events to the Community Calendar, with images. The pipeline handles edge cases like missing end times, missing contact info, virtual vs in-person vs hybrid events, and event category mapping.

---

## What Is Next

### Step 1 — Add AI Deduplication to the Localist Sync

The current pipeline already avoids reposting the same Localist event using a simple ID check. But the real deduplication problem comes later: when the same real-world event is posted by two different organizations on two different platforms, there is no shared ID to compare. That is when we need AI.

You might think we could just compare titles. But organizations word the same event differently. One calendar might say "Spring Chamber Music Concert" and another says "Oberlin Conservatory Chamber Performance — April 26." A string comparison would say these are different events. They are not. An AI can read both listings in full, understand the context, and make the right call.

So the next step is to wire an AI agent into the sync pipeline. Before posting any event, the agent reads the incoming event and compares it against everything already on the calendar for that day. If it decides the event is a duplicate, it flags it and blocks the post. If it decides it is new, the event goes through normally.

### Step 2 — Build a Management and Insights Dashboard

Because this is a research project, we do not just want the AI to make decisions silently. We want to measure how well it is doing and give humans a way to correct it.

We will build a dashboard with a **Duplicates** tab. Every time the AI agent rejects an event as a duplicate, that event goes into a review queue instead of being deleted automatically. The tab shows both events side by side — the one already on the calendar and the one that was flagged — and a human reviewer decides:

- **Confirmed duplicate** — the AI was right. The flagged event is discarded.
- **Not a duplicate** — the AI was wrong. The event is submitted to the calendar as normal.

Every decision the human makes is a data point. If the AI flagged 10 events as duplicates and the human confirmed 9 of them, the agent is scoring 9/10. This gives us a clear accuracy metric for the research and a feedback loop for improving the agent over time.

### Step 3 — Add a New Calendar Source

Once AI deduplication is running and the dashboard is live, we add the next source calendar (FAVA, AMAM, City of Oberlin, etc.) and confirm the full pipeline works end to end — fetch, deduplicate, post, and flag for review where needed.

---

## Technical Reference

### Field Mapping

| Calendar API Field | Source |
|---|---|
| `title` | `event.title` (max 60 chars) |
| `description` | `event.description_text` (max 200 chars) |
| `extendedDescription` | `event.description_text` (max 1000 chars) |
| `email` / `contactEmail` | `event.custom_fields.contact_email_address` |
| `phone` | `event.custom_fields.contact_phone_number` |
| `website` | `event.localist_url` |
| `sponsors` | `event.filters.departments[].name` |
| `postTypeId` | mapped from `event.filters.event_types[].name` |
| `sessions.startTime` | `event.event_instances[0].start` (unix) |
| `sessions.endTime` | `event.event_instances[0].end` (unix) |
| `locationType` | `event.experience` mapped to `ph2` / `on` / `bo` |
| `location` | `event.address` or `event.location_name` |
| `urlLink` | `event.stream_url` (if virtual or hybrid) |
| `image` | `event.photo_url` fetched and sent as base64 data URI |

### Event Type Mapping

| Localist Type | Category ID |
|---|---|
| Lecture / Talk / Presentation / Seminar | `6` |
| Music / Concert | `8` |
| Theatre / Dance / Performance | `9` |
| Workshop / Class | `7` |
| Exhibit / Exhibition / Gallery | `2` |
| Festival / Fair / Celebration | `3` |
| Tour / Open House | `4` |
| Sport / Recreation / Game | `12` |
| Networking | `13` |
| Anything else | `89` (Other) |

### Setup

**GitHub Secret required:**

| Secret | Value |
|---|---|
| `FALLBACK_EMAIL` | Email used when an event has no contact email |

Add it at: `Settings > Secrets and variables > Actions > New repository secret`

The sync runs every hour automatically. To trigger it manually: `Actions > Localist > CommunityHub Sync > Run workflow`

### Files

| File | Purpose |
|---|---|
| `sync.js` | Main sync script |
| `pushed_ids.json` | Tracks already-posted Localist event IDs |
| `FUTURE_IMPLEMENTATION.md` | Detailed technical roadmap |
| `.github/workflows/sync.yml` | GitHub Actions hourly schedule |
