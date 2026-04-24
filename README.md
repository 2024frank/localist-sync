# Oberlin Community Calendar Unification

An AI-assisted project to bring all Oberlin community events into one place.

---

## The Problem

Event information in Oberlin is scattered. Oberlin College, FAVA, AMAM, the City of Oberlin, local businesses, and student organizations each manage their own calendar on their own platform. There is no single place where students, faculty, staff, and Oberlin residents can see everything happening in the community.

---

## The Goal

Build a system that automatically pulls events from every major Oberlin community source, runs them through an AI review pipeline, and lets a human reviewer approve them before they appear on the [Oberlin Community Calendar](https://oberlin.communityhub.cloud).

---

## Who Is Involved

| Person | Role |
|---|---|
| Frank Kusi Appiah | Developer, project lead (Oberlin College, Class of 2027) |
| Prof. John Petersen | Faculty advisor |

---

## Pipeline Flow

Events **never** go to CommunityHub automatically. Every event must be approved by a human reviewer in the dashboard.

```
Source Calendar (Localist, AMAM, etc.)
        │
        ▼
1. Fetch CommunityHub snapshot
   └─ Pull all current CH events to use for duplicate detection

2. Fetch events from source
   └─ Localist API: all live, public events up to 365 days ahead

3. Duplicate Agent  ──────────────────────────────────────────────
   └─ Same date + title/location overlap? → Pre-filter candidate
   └─ Gemini confirms at ≥70% confidence → Tag as duplicate
   └─ Duplicate: sent to Duplicates tab (not posted)

4. Public Agent  ─────────────────────────────────────────────────
   └─ Is this event open to any Oberlin resident (no affiliation)?
   └─ Private at ≥75% confidence → Rejected tab (not posted)

5. Writer Agent  ─────────────────────────────────────────────────
   └─ Gemini cleans description: removes URLs, shortens to limits
   └─ Produces "before" (original) and "after" (cleaned) versions

6. Review Queue tab on dashboard  ───────────────────────────────
   └─ Reviewer sees: original event │ Writer's cleaned version
   └─ Reviewer can edit any field
   └─ Approve → event posted to CommunityHub
   └─ Reject → counted in analytics

7. Duplicates tab  ───────────────────────────────────────────────
   └─ Shows flagged pairs side by side
   └─ Confirm → discard the incoming event
   └─ Override → post it anyway (AI was wrong)
```

---

## Dashboard

The research dashboard is deployed at `https://ai-microgrant-research-oberlin.vercel.app`.

Sign in with an authorized Google account. Only `frankkusiap@gmail.com` has admin access by default. Other users can be added from the Users page.

| Page | Purpose |
|---|---|
| Overview | Pipeline stats: events analyzed, queued, skipped, last run |
| Review Queue | Approve or reject events before they go to CommunityHub |
| Rejected | Events blocked by the AI agents (private or duplicate) |
| Sources | Trigger a sync run manually; view last run details |
| Duplicates | Review flagged duplicate pairs |
| AI Analysis | Gemini agent performance metrics |
| Users | Add/remove authorized Google accounts (admin only) |

---

## Technical Reference

### Firestore Collections

| Collection | Purpose |
|---|---|
| `review_queue` | Events waiting for human approval (status: pending / approved / rejected_manual) |
| `rejected` | Events blocked by AI agents (reason: private or duplicate) |
| `duplicates` | Flagged duplicate pairs pending human review |
| `syncs` | Pipeline run statistics |

### Field Mapping

| CommunityHub Field | Source |
|---|---|
| `title` | `event.title` (max 60 chars) |
| `description` | `event.description_text` — Gemini cleaned, max 200 chars |
| `extendedDescription` | `event.description_text` — Gemini cleaned, max 1000 chars |
| `email` / `contactEmail` | `event.custom_fields.contact_email_address` |
| `phone` | `event.custom_fields.contact_phone_number` |
| `website` | `event.localist_url` |
| `sponsors` | `event.filters.departments[].name` |
| `postTypeId` | Mapped from `event.filters.event_types[].name` |
| `sessions.startTime` | `event.event_instances[0].start` (unix timestamp) |
| `sessions.endTime` | `event.event_instances[0].end` (unix timestamp) |
| `locationType` | `event.experience` → `ph2` / `on` / `bo` |
| `location` | `event.address` or `event.location_name` |
| `urlLink` | `event.stream_url` (virtual or hybrid only) |
| `image` | `event.photo_url` fetched and base64-encoded at push time |

### Event Type Mapping

| Localist Type | Category ID |
|---|---|
| Lecture / Talk / Presentation / Seminar / Conference | `6` |
| Music / Concert | `8` |
| Theatre / Dance / Performance | `9` |
| Workshop / Class | `7` |
| Exhibit / Exhibition / Gallery | `2` |
| Festival / Fair / Celebration | `3` |
| Tour / Open House | `4` |
| Sport / Recreation / Game | `12` |
| Networking | `13` |
| Anything else | `89` (Other) |

### Files

| File | Purpose |
|---|---|
| `sync.js` | Main pipeline script (run by GitHub Actions) |
| `pushed_ids.json` | Reserved — currently unused; Firestore tracks processed IDs |
| `dashboard/` | Next.js research dashboard (deployed on Vercel) |
| `.github/workflows/sync.yml` | GitHub Actions workflow (manual trigger) |

### GitHub Secrets Required

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Admin SDK credentials |
| `GEMINI_API_KEY` | Google Gemini API key for AI agents |
| `FALLBACK_EMAIL` | Default contact email when an event has none |
| `GITHUB_PAT` | Personal access token for workflow triggering |

### Triggering a Sync

The sync runs manually only. To trigger it:

1. Go to **GitHub → Actions → Localist → CommunityHub Sync → Run workflow**
2. Or use the **Start** button on the Sources page of the dashboard

---

## What Is Next

- Add AMAM, FAVA, and City of Oberlin as additional sources
- Scheduled automatic sync (currently manual only)
- Events page in dashboard showing all approved/pushed events
- AI agent accuracy metrics and feedback loop
