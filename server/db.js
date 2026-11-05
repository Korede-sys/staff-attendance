const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Create a Postgres database (e.g. Neon, Vercel Postgres, Supabase) ' +
    'and set DATABASE_URL in your environment before starting the server.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most hosted Postgres providers (Neon, Vercel Postgres, Supabase, etc.)
  // require SSL. Allow opting out for a fully local/self-hosted Postgres
  // via DATABASE_SSL=false.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  staff_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  qr_token TEXT UNIQUE NOT NULL,
  shift_start TEXT NOT NULL DEFAULT '09:00',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  work_date TEXT NOT NULL,
  check_in_at TIMESTAMPTZ NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  minutes_late INTEGER NOT NULL DEFAULT 0,
  UNIQUE(staff_id, work_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_credentials (
  id SERIAL PRIMARY KEY,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id SERIAL PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-date shift overrides, for staff whose shift time changes day to day
-- (e.g. rotating Customer Service / Risk shifts imported from a
-- spreadsheet). A staff member with no row here for a given date just uses
-- their fixed staff.shift_start (the normal case for permanent 9-5 roles).
CREATE TABLE IF NOT EXISTS staff_shifts (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  shift_date TEXT NOT NULL,
  shift_start TEXT NOT NULL,
  UNIQUE(staff_id, shift_date)
);
`;

// Serverless platforms spin up a fresh function instance per cold start, so
// this init runs more than once across the app's lifetime (but only once
// per warm instance). All statements are idempotent (IF NOT EXISTS / ON
// CONFLICT), so that's safe. `ready` is awaited before the first query each
// cold start; subsequent calls on the same warm instance resolve instantly.
let ready = null;
function init() {
  if (!ready) {
    ready = pool.query(schemaSql).then(() => ensureDefaults());
  }
  return ready;
}

async function ensureDefaults() {
  if ((await getSettingRaw('grace_period_minutes')) === null) {
    await setSetting('grace_period_minutes', '5');
  }
  if ((await getSettingRaw('org_name')) === null) {
    await setSetting('org_name', 'My Company');
  }
  if ((await getSettingRaw('admin_pin_hash')) === null) {
    // Default admin PIN "1234" — must be changed on first login.
    await setSetting('admin_pin_hash', hashPin('1234'));
    await setSetting('admin_pin_is_default', '1');
  }
}

// Internal, schema-unaware versions — only safe to call once the schema is
// known to exist (i.e. from within ensureDefaults, during init() itself).
async function getSettingRaw(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
async function setSettingRaw(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}
// Alias used inside ensureDefaults above.
const setSetting = setSettingRaw;

// Public versions — safe to call from anywhere (route handlers, cold
// starts) because they guarantee the schema/defaults exist first.
async function getSettingPublic(key, fallback) {
  await init();
  const value = await getSettingRaw(key);
  return value === null ? fallback : value;
}
async function setSettingPublic(key, value) {
  await init();
  return setSettingRaw(key, value);
}

// Thin wrapper so route handlers can `await db.query(...)` directly and
// get back the same `{ rows }` shape as node-postgres, after guaranteeing
// the schema/defaults are ready.
async function query(text, params) {
  await init();
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
  init,
  getSetting: getSettingPublic,
  setSetting: setSettingPublic,
  hashPin,
};
