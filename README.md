# AI Community Calendar Aggregator

An open-source civic tech tool that uses AI agents to aggregate events from multiple community organizations, routes them through human review, and publishes them to a unified community calendar.

Built as part of the **Oberlin College AI Micro-Grant Program** in partnership with the **Environmental Dashboard**.

Live: [ai-microgrant-research-oberlin.vercel.app](https://ai-microgrant-research-oberlin.vercel.app)

---

## How It Works

1. **Admin adds a source** — a community org name plus a Claude agent ID. All agents share the same environment and credential vault from env vars.
2. **Agents run on schedule** — each agent fetches and extracts events from its source, deduplicates against CommunityHub, and outputs structured JSON via the ingest API.
3. **Events land in the review queue** — every extracted event enters `raw_events` with `status: pending` and an `ingestedPostUrl` deep link back to this app.
4. **Reviewers approve or reject** — a role-based UI lets human reviewers edit fields, approve, or reject. Every edit and every rejection is logged for research benchmarking.
5. **Approved events go to CommunityHub** — submitted via the CommunityHub API with the `ingestedPostUrl` so editors can trace origin.
6. **Agents learn from rejections** — the full rejection history for a source is injected into that agent's system prompt before each run, so it improves over time.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend + API | Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 |
| Auth | Firebase Authentication (Google sign-in) |
| Database | MySQL 8 on DigitalOcean Managed Database |
| AI Agents | Anthropic Claude (one managed agent per source org) |
| Email | Resend |
| Hosting | Vercel |
| CI | GitHub Actions |

---

## Project Structure

```
src/
├── app/
│   ├── admin/          # Admin pages: sources, users, stats, analytics, controls
│   ├── reviewer/       # Reviewer pages: queue, event cards, dashboard
│   ├── events/         # Public event views: approved, pending, rejected, deep links
│   ├── login/          # Google sign-in page
│   ├── settings/       # User settings
│   └── api/            # All API routes (see API section below)
├── components/         # Shared UI components
├── hooks/              # React hooks (useAuth)
└── lib/
    ├── agentRunner.ts  # Anthropic Sessions API integration
    ├── auth.ts         # Firebase token verification
    ├── db.ts           # MySQL connection pool
    ├── email.ts        # Resend email helpers
    ├── firebase.ts     # Firebase client config
    ├── firebase-admin.ts
    ├── rejectionHistory.ts  # Builds few-shot rejection prompt for agents
    └── timezone.ts
scripts/
└── seed-admins.ts      # One-time admin user seed
schema.sql              # Full MySQL 8 schema
docs/api.md             # Full API reference
```

---

## Getting Started

### Prerequisites

- Node.js 22+
- MySQL 8 instance (local or DigitalOcean Managed Database)
- Firebase project with Google Auth enabled
- Anthropic API key + at least one managed agent created in the Anthropic console

### Installation

```bash
git clone https://github.com/2024frank/ai-microgrant.git
cd ai-microgrant
npm install
npm run setup        # copies .env.local.example → .env.local
```

Fill in `.env.local` with your credentials (see [Environment Variables](#environment-variables) below), then:

```bash
# Apply the database schema
npm run db:schema

# Seed your first admin user
npm run db:seed

# Start the dev server
npm run dev
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes | Firebase client API key |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes | Firebase auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Yes | Firebase storage bucket |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Yes | Firebase messaging sender ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Yes | Firebase app ID |
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Firebase Admin SDK JSON (stringified) |
| `DATABASE_HOST` | Yes | MySQL host |
| `DATABASE_PORT` | Yes | MySQL port (default: `25060`) |
| `DATABASE_USERNAME` | Yes | MySQL username |
| `DATABASE_PASSWORD` | Yes | MySQL password |
| `DATABASE_NAME` | Yes | Database name |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `SOURCE_BUILDER_ENVIRONMENT_ID` | Yes | Shared Claude environment ID |
| `SOURCE_BUILDER_VAULT_ID` | Yes | Shared Claude vault ID |
| `RESEND_API_KEY` | Yes | Resend email API key |
| `CRON_SECRET` | Yes | Secret for Vercel cron authentication |
| `NEXT_PUBLIC_APP_URL` | Yes | Full app URL (e.g. `https://your-app.vercel.app`) |
| `ADMIN_EMAIL` | Optional | Receives agent run summary emails |
| `SETUP_SECRET` | Once | Protects `/api/setup` — remove after seeding |

---

## Database Schema

Seven tables, all in MySQL 8 (`utf8mb4`):

| Table | Purpose |
|---|---|
| `sources` | Community org name, slug, Claude agent ID, cron schedule |
| `users` | Admin and reviewer accounts, linked to Firebase UID |
| `reviewer_sources` | Which reviewers are assigned to which sources |
| `agent_runs` | Run history: status, token counts, extracted/skipped/errored counts |
| `raw_events` | Every extracted event with full structured fields and review status |
| `rejection_log` | Every rejection: reason codes, reviewer note, event snapshot (fed back to agent) |
| `field_edit_log` | Every field-level edit a reviewer makes (research benchmarking data) |
| `review_sessions` | Per-event review action, time spent, CommunityHub submission result |

---

## API Overview

Full documentation in [docs/api.md](docs/api.md).

### Public (no auth required)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/events` | List events — filterable by status, source, type, geo scope, date range, full-text search |
| `GET` | `/api/events/:id` | Single event by ID (used by the `ingestedPostUrl` deep link) |

### Authenticated (Firebase Bearer token)

| Method | Route | Role | Description |
|---|---|---|---|
| `GET/POST` | `/api/sources` | Any / Admin | List sources; add a source |
| `PATCH/DELETE` | `/api/sources/:id` | Admin | Update or deactivate a source |
| `POST` | `/api/agent/trigger/:source_id` | Admin | Manually trigger an agent run |
| `GET` | `/api/agent/runs` | Admin | Agent run history with live status |
| `GET` | `/api/agent/schedule` | Cron | Daily scheduled run (secured with `CRON_SECRET`) |
| `GET` | `/api/review/queue` | Reviewer | Pending events for review |
| `GET` | `/api/review/events/:id` | Reviewer | Full event detail for review card |
| `POST` | `/api/review/events/:id/action` | Reviewer | Approve or reject |
| `POST` | `/api/events/:id/edit` | Reviewer | Edit fields without approving |
| `GET` | `/api/admin/stats` | Admin | Analytics: approval rates, timelines, exports |
| `GET` | `/api/admin/activity` | Admin | Live activity feed and reviewer stats |
| `GET/POST` | `/api/users` | Admin | List users; invite a new user |
| `PATCH` | `/api/users/:id` | Admin | Update role, active status, source assignments |
| `GET` | `/api/reviewer/dashboard` | Reviewer | Personal dashboard data |
| `GET` | `/api/auth/me` | Any | Current user profile |

---

## User Roles

| Role | Access |
|---|---|
| **Admin** | Everything: source management, user management, agent triggering, analytics |
| **Reviewer** | Review queue for assigned sources, personal dashboard, event editing |

Authentication is Firebase Google sign-in. Role is stored in the `users` table and resolved server-side on every request.

---

## Scripts

```bash
npm run dev              # Development server
npm run build            # Production build
npm run test             # Jest test suite
npm run test:coverage    # Tests with coverage report
npm run lint             # ESLint
npm run ci               # lint + tests (used in CI)
npm run db:schema        # Apply schema.sql to your database
npm run db:seed          # Seed initial admin users
```

---

## CI/CD

GitHub Actions runs on every push and PR to `main`:

1. Install dependencies
2. Run Jest tests
3. TypeScript type check
4. Next.js production build

Deployment is via Vercel. Vercel Cron triggers `GET /api/agent/schedule` daily at 6am to run all active agents.

---

## Open Source

No hardcoded org names anywhere — all source names, agent IDs, and config live in the database. This tool can be deployed for any community that wants AI-assisted event aggregation with human-in-the-loop review.

---

## License

MIT
