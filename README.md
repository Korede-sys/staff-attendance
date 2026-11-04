# Staff Attendance Kiosk

A lightweight attendance system for a single kiosk phone at your entrance. Staff
check in by scanning a personal QR code or entering their Staff ID + PIN; the
system compares the time against each person's shift start and flags late
arrivals automatically. A web admin dashboard lets you manage staff, view
today's attendance, and run lateness reports.

## What's included

- **Kiosk screen** (`/kiosk`) — the check-in screen for the phone mounted at
  your entrance. QR scan via the camera, or a Staff ID + PIN keypad.
- **Admin dashboard** (`/admin`) — staff management, today's attendance,
  lateness reports, and settings. Protected by an admin PIN, with an optional
  Face ID / fingerprint unlock for that specific phone.
- **Backend** — Node.js + Express, built to run as a Vercel serverless
  function, backed by a Postgres database (works with any Postgres — Neon,
  Vercel Postgres, Supabase, or your own).

### About the biometric options

Mobile phones don't let apps read a shared fingerprint sensor to identify
*which* staff member just walked up — the phone's Face ID/fingerprint only
confirms "this is the phone's owner." Since this is a single shared kiosk
phone, that can't tell staff apart. So in this build:

- **Staff check-in** uses **QR code** or **Staff ID + PIN** — both reliably
  identify an individual on shared hardware.
- **Phone biometric unlock** (Face ID / fingerprint) is used to protect the
  **admin dashboard** on that phone, so staff can't open settings or edit
  records without the PIN or the phone owner's own biometric.

If you later get a dedicated fingerprint scanner (e.g. a ZKTeco-style USB/
network device), that's a separate integration — talk to me and I can wire it
into the same backend.

## Deploying to Vercel

### 1. Create a Postgres database

Vercel's functions don't keep a local disk between requests, so attendance
data lives in a real Postgres database instead of a file. Any of these work
and have a free tier:

- **Neon** (neon.tech) — easiest if deploying via Vercel, since Vercel has a
  built-in Neon integration (Vercel dashboard → Storage → Create Database →
  Postgres).
- **Supabase** (supabase.com)
- Any other hosted Postgres — just need its connection string.

Once created, copy its connection string (looks like
`postgresql://user:password@host/dbname?sslmode=require`).

### 2. Push this project to a Git repo

Vercel deploys from a Git repository (GitHub, GitLab, or Bitbucket). Create a
new repo and push this project to it.

### 3. Import the project into Vercel

In the Vercel dashboard: **Add New → Project**, select your repo, and before
deploying, add these **Environment Variables**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The Postgres connection string from step 1 |
| `ADMIN_JWT_SECRET` | A long random string — generate one with `openssl rand -hex 32` |

Then click **Deploy**. Vercel detects the Express app automatically (no
build step needed) and serves the kiosk/admin pages as static files.

### 4. First login

Open `https://your-project.vercel.app/admin`. **Default admin PIN is `1234`.**
Log in and change it immediately under Settings → Admin PIN.

### 5. Set the timezone

Lateness is computed from the server's clock, so set the function's timezone
to your location. In the Vercel dashboard: **Project → Settings →
Environment Variables**, add:

| Variable | Value |
|---|---|
| `TZ` | e.g. `Africa/Lagos` |

Redeploy after adding it (environment variable changes require a new
deployment to take effect).

## Running it locally (for development/testing)

```bash
npm install
```

You'll need a Postgres database reachable locally — either a local Postgres
install, or point `DATABASE_URL` at your Neon/Supabase database. Then:

```bash
export DATABASE_URL="postgresql://user:password@host:5432/dbname"
export ADMIN_JWT_SECRET="$(openssl rand -hex 32)"
export TZ="Africa/Lagos"
npm start
```

Then open:
- Kiosk screen: `http://localhost:3000/kiosk`
- Admin dashboard: `http://localhost:3000/admin`

> If your local Postgres doesn't use SSL, also set `DATABASE_SSL=false`.

## First-time setup (after deploying)

1. Open `/admin`, log in with PIN `1234`, change the PIN.
2. Go to **Staff** → **Add Staff** for each employee: name, a Staff ID, a PIN,
   and their shift start time.
3. For each staff member, click **QR code** to view/print their personal QR
   code. Staff can keep a printed copy, or save the image to their own phone
   to scan at the kiosk.
4. Go to **Settings** and set your organization name and the grace period
   (minutes allowed after shift start before someone is marked late).
5. On the kiosk phone, open `https://your-project.vercel.app/kiosk` in
   Chrome and use **Add to Home Screen** so it behaves like an installed
   app. Mount the phone at the entrance. (Camera access requires HTTPS,
   which Vercel provides automatically.)
6. Optionally, on that same kiosk phone, go to `/admin` → Settings →
   Biometric unlock → **Set up on this device**, so admin actions on that
   phone can be unlocked with Face ID/fingerprint as well as the PIN.

## How the Vercel version differs from a self-hosted one

- **Database**: Postgres instead of a local SQLite file, since serverless
  functions don't retain local disk state between requests.
- **Admin sessions**: a signed token (JWT) instead of an in-memory session
  list, since serverless functions don't share memory between invocations —
  each login issues a token that's verified fresh on every request.
- **Static files**: served directly by Vercel's CDN from `public/`, not by
  the Express app itself (Vercel ignores `express.static()` in this setup).

None of this changes how the app looks or behaves for staff or admins — it's
purely about making the backend work on serverless infrastructure.

## Data & backups

Everything lives in your Postgres database. Most providers (Neon, Supabase)
offer automatic daily backups on their free/low tiers — check your
provider's dashboard. For extra safety, you can also run `pg_dump` against
your `DATABASE_URL` periodically.

## Limitations to be aware of

- This is a **single kiosk** design — one phone, staff queue up to check in.
  It isn't built for every staff member having the app on their own phone
  with GPS/geofencing; ask if you want that instead (a different, larger
  build).
- No photo capture or facial recognition is included.
- The admin PIN protects the dashboard; there's no multi-admin login with
  separate accounts/roles yet.
- Shift times are currently a single fixed time per staff member (good for
  standard 9–5 roles). If you need rotating/shift-based schedules (e.g. for
  departments that already track shifts in Excel), that's a planned
  follow-up — let me know when you're ready to prioritize it.
