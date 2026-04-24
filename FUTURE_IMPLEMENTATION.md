# Future Implementation Plan

This document describes the planned next phases of the Oberlin Community Calendar Unification project. Phase 1 (Localist sync) is complete and running. Everything below is planned work.

---

## Phase 2 — Additional Calendar Sources

Right now the pipeline only pulls from Oberlin College's Localist calendar. The goal is to expand to every major Oberlin community organization.

### Target Sources

| Organization | Likely Feed Format |
|---|---|
| FAVA (Fine Arts) | Website / iCal |
| AMAM (Allen Memorial Art Museum) | Website / iCal |
| City of Oberlin | Website / iCal or RSS |
| Local businesses and venues | Various |
| Oberlin Public Library | Website |
| Student organizations (non-Localist) | Manual or scraped |

### Implementation Approach

Each source gets its own sync module that:
1. Fetches events from the source (API, iCal, RSS, or web scrape)
2. Normalizes the event data into a shared internal format
3. Passes the normalized event to a shared `pushToCommunityHub()` function

The shared format will include: `title`, `description`, `startTime`, `endTime`, `location`, `contactEmail`, `eventUrl`, `imageUrl`, `sourceId`, `sourceName`.

Deduplication across sources (e.g., an AMAM event that also appears on Localist) is handled by Phase 3.

### iCal Sources

For organizations that publish `.ics` files, we will use the `node-ical` package to parse the feed. Each event's `UID` from the iCal spec serves as the stable source ID for deduplication within that source.

### Scraped Sources

For organizations without a machine-readable feed, we will write a lightweight scraper using `cheerio`. These require more maintenance and will be prioritized last.

---

## Phase 3 — AI Deduplication + Human Review Dashboard

### Why We Need AI for This

Once events are coming in from multiple source calendars, the same real-world event will appear more than once. A concert at Finney Chapel might be posted by the music department on Localist and by FAVA on their own calendar. These two listings will have different titles, different descriptions, and different contact info — but they are the same event.

Simple string matching does not work here. You cannot compare "Spring Chamber Music Concert" against "Oberlin Conservatory Chamber Performance — April 26" and get a reliable answer. The wording is too different. An AI agent can read both listings in full, understand what each one is describing, and make the right call. That is what this phase builds.

### How the Duplicate Agent Works

Before posting any new event, the sync script runs it through a duplicate check:

```
For each new incoming event:
  1. Pull all events already on the calendar for that day
  2. Filter to events within 30 minutes of the same start time
  3. If there are candidates:
       a. Send both events to the AI agent with a comparison prompt
       b. Agent returns: DUPLICATE or NEW
       c. If DUPLICATE: flag the event, do not post it, send to review queue
       d. If NEW: post the event as normal
  4. If no candidates: post the event as normal
```

Start time is the anchor because it is the most stable field across platforms. Two events at the same time and place are almost certainly the same event — the AI just confirms it by reading the content.

### The Management and Insights Dashboard

Because this is a research project, we do not want the AI making silent decisions. We want to measure how well it works and give humans a way to correct it when it is wrong.

We will build a dashboard with a **Duplicates** tab. Every event the AI agent flags goes into a review queue instead of being discarded automatically. The tab shows the two events side by side:

- The event already on the calendar
- The incoming event the agent flagged as a duplicate

A human reviewer looks at both and makes a call:

**Option 1 — Confirmed duplicate**
The human agrees with the agent. The flagged event is discarded. The agent gets a point.

**Option 2 — Not a duplicate**
The human disagrees. The flagged event is submitted to the calendar as a new event. The agent gets marked wrong.

### Research Grading

Every human decision is a data point for grading the agent's accuracy. If the agent flagged 10 events and the human confirmed 9 of them were real duplicates, the agent scores 9/10 for that batch. Over time this gives us:

- A clear accuracy metric showing how well the AI identifies duplicates
- A labeled dataset of confirmed and rejected duplicate pairs
- A feedback loop — patterns in the wrong calls can inform prompt improvements

This is the core research contribution: not just building a deduplication system, but measuring how well AI can solve this problem in a real community calendar context.

### LLM Choice

We plan to use **Google Gemini** (via the Gemini API) because:
- Oberlin has a relationship with Google through the grant program
- API tokens are being requested through the grant
- Gemini Flash is fast and cheap for short comparison prompts

Fallback: if no API key is available, all events with matching start times get flagged automatically for human review rather than being blocked.

### Prompt Template (Draft)

```
You are helping deduplicate community event listings.

Event A (already on the calendar):
Title: {titleA}
Start: {startA}
Location: {locationA}
Description: {descriptionA}

Event B (incoming, candidate to post):
Title: {titleB}
Start: {startB}
Location: {locationB}
Description: {descriptionB}

Are Event A and Event B the same real-world event?
Answer only DUPLICATE or NEW.
```

### Implementation Notes

- The AI call only happens when there are candidates (same day, within 30 minutes). Most events will have no candidates and go straight through.
- We cache the calendar event list at the start of each sync run to avoid repeated API calls.
- False positives (blocking a real new event) are worse than false negatives (letting a duplicate through). The prompt will be tuned to prefer NEW when uncertain — the human review queue is the safety net.
- The dashboard review queue is persistent. Flagged events stay in the queue until a human acts on them.

---

## Phase 4 — Edit and Delete Support

The current pipeline can only create events. CommunityHub does not yet expose edit or delete endpoints. When those become available, the pipeline will:

### Edit
- On each sync run, compare the current Localist event data against what was previously pushed
- If the title, description, time, or location changed: call the edit endpoint
- Store a hash of the last-pushed payload alongside the event ID in `pushed_ids.json` to detect changes without re-calling CommunityHub

### Delete
- When a Localist event is cancelled or set to private: call the delete endpoint
- When a duplicate is confirmed by the AI deduplication check for an already-pushed event: call the delete endpoint to remove it

### pushed_ids.json Schema Change (Phase 4)

Currently `pushed_ids.json` is a flat array of ID strings. Phase 4 requires storing more metadata:

```json
{
  "12345": {
    "pushedAt": 1714000000,
    "communityHubId": "abc-def-ghi",
    "payloadHash": "sha256:..."
  }
}
```

This is a breaking change to the file format and will require a one-time migration.

---

## Phase 5 — Monitoring and Alerting

Once multiple sources are running, we need visibility into failures.

Planned:
- Daily summary email (or Slack message) showing events pushed, skipped, failed, and duplicates detected
- Alert when a source feed is unreachable for more than 6 hours
- Dashboard (simple HTML page hosted via GitHub Pages) showing sync status per source

---

## Dependency Tracker

| Feature | Blocked On |
|---|---|
| AI deduplication | Gemini API key (requested via grant) |
| Edit pushed events | CommunityHub edit endpoint (Hitesh) |
| Delete pushed events | CommunityHub delete endpoint (Hitesh) |
| Duplicate cleanup (current) | CommunityHub delete endpoint (Hitesh) |
| FAVA / AMAM sources | Confirming their feed URLs / formats |
