const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const QRCode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const db = require('./db');
const { createSession, requireAdmin } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB — well under Vercel's function body limit
});

// ---------- helpers ----------
// Vercel Functions always run with the server clock in UTC, and Vercel
// reserves the TZ environment variable so it can't be overridden from the
// dashboard. Rather than depend on the server's local timezone at all, we
// compute "today" and "now" directly in the organization's configured IANA
// timezone using Intl, which works the same whether this runs on Vercel,
// locally, or anywhere else.
function getTimeZone() {
  return process.env.APP_TIMEZONE || 'Africa/Lagos';
}
function zonedParts(d = new Date(), timeZone = getTimeZone()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    timeStr: `${parts.hour}:${parts.minute}`,
  };
}
function todayStr(d = new Date()) {
  return zonedParts(d).dateStr;
}
function timeStr(d = new Date()) {
  return zonedParts(d).timeStr;
}
function minutesSinceMidnight(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function originFromReq(req) {
  // Used for WebAuthn rpID/origin — derived from the request so it works
  // whether the kiosk reaches the server by IP, hostname, or a Vercel
  // domain. Vercel terminates TLS in front of the function, so the
  // original scheme arrives via x-forwarded-proto.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}
function rpIDFromReq(req) {
  return req.hostname;
}

// Returns the shift start time that actually applies to this staff member
// on this date: a per-date override from an imported shift schedule if one
// exists, otherwise their normal fixed shift_start.
async function effectiveShiftStart(staffId, date, fallback) {
  const { rows } = await db.query(
    'SELECT shift_start FROM staff_shifts WHERE staff_id = $1 AND shift_date = $2',
    [staffId, date]
  );
  return rows.length ? rows[0].shift_start : fallback;
}

async function recordCheckIn(staff, method) {
  const now = new Date();
  const date = todayStr(now);
  const nowTime = timeStr(now);
  const shiftStart = await effectiveShiftStart(staff.id, date, staff.shift_start);
  const shiftMinutes = minutesSinceMidnight(shiftStart);
  const nowMinutes = minutesSinceMidnight(nowTime);
  const grace = Number(await db.getSetting('grace_period_minutes', 5));
  const lateBy = nowMinutes - shiftMinutes - grace;
  const status = lateBy > 0 ? 'late' : 'on_time';
  const minutesLate = Math.max(0, nowMinutes - shiftMinutes);

  const existing = await db.query(
    'SELECT id FROM attendance WHERE staff_id = $1 AND work_date = $2',
    [staff.id, date]
  );
  if (existing.rows.length) {
    return { alreadyCheckedIn: true };
  }

  try {
    await db.query(
      `INSERT INTO attendance (staff_id, work_date, check_in_at, method, status, minutes_late)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [staff.id, date, now.toISOString(), method, status, minutesLate]
    );
  } catch (err) {
    // Unique violation — a near-simultaneous second check-in slipped past
    // the SELECT above. Treat it the same as "already checked in".
    if (err.code === '23505') return { alreadyCheckedIn: true };
    throw err;
  }

  return { alreadyCheckedIn: false, status, minutesLate, time: nowTime };
}

// ---------- public kiosk endpoints ----------

app.get('/api/public/settings', async (req, res, next) => {
  try {
    res.json({ orgName: await db.getSetting('org_name', 'My Company') });
  } catch (err) { next(err); }
});

app.post('/api/checkin/qr', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing QR token' });

    const { rows } = await db.query(
      'SELECT * FROM staff WHERE qr_token = $1 AND active = 1',
      [token]
    );
    const staff = rows[0];
    if (!staff) return res.status(404).json({ error: 'QR code not recognized' });

    const result = await recordCheckIn(staff, 'qr');
    if (result.alreadyCheckedIn) {
      return res.json({ ok: true, alreadyCheckedIn: true, name: staff.name });
    }
    res.json({ ok: true, name: staff.name, status: result.status, minutesLate: result.minutesLate, time: result.time });
  } catch (err) { next(err); }
});

app.post('/api/checkin/pin', async (req, res, next) => {
  try {
    const { staffCode, pin } = req.body || {};
    if (!staffCode || !pin) return res.status(400).json({ error: 'Missing staff ID or PIN' });

    const { rows } = await db.query(
      'SELECT * FROM staff WHERE staff_code = $1 AND active = 1',
      [String(staffCode).trim()]
    );
    const staff = rows[0];
    if (!staff || staff.pin_hash !== db.hashPin(pin)) {
      return res.status(401).json({ error: 'Staff ID or PIN not recognized' });
    }

    const result = await recordCheckIn(staff, 'pin');
    if (result.alreadyCheckedIn) {
      return res.json({ ok: true, alreadyCheckedIn: true, name: staff.name });
    }
    res.json({ ok: true, name: staff.name, status: result.status, minutesLate: result.minutesLate, time: result.time });
  } catch (err) { next(err); }
});

// ---------- admin auth (PIN) ----------

app.post('/api/admin/login', async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ error: 'Missing PIN' });
    const stored = await db.getSetting('admin_pin_hash', null);
    if (stored !== db.hashPin(pin)) {
      return res.status(401).json({ error: 'Incorrect admin PIN' });
    }
    const token = createSession();
    const isDefault = (await db.getSetting('admin_pin_is_default', '0')) === '1';
    res.json({ token, mustChangePin: isDefault });
  } catch (err) { next(err); }
});

app.post('/api/admin/change-pin', requireAdmin, async (req, res, next) => {
  try {
    const { newPin } = req.body || {};
    if (!newPin || String(newPin).length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 digits' });
    }
    await db.setSetting('admin_pin_hash', db.hashPin(newPin));
    await db.setSetting('admin_pin_is_default', '0');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- admin: WebAuthn (Face ID / fingerprint unlock) ----------
// Used to gate the admin dashboard with the kiosk phone's own biometric
// unlock, in addition to (not instead of) the admin PIN.

app.get('/api/admin/webauthn/register-options', requireAdmin, async (req, res, next) => {
  try {
    const { rows: existing } = await db.query('SELECT credential_id FROM admin_credentials');
    const options = await generateRegistrationOptions({
      rpName: await db.getSetting('org_name', 'My Company'),
      rpID: rpIDFromReq(req),
      userID: Buffer.from('admin'),
      userName: 'admin',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
      },
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, type: 'public-key' })),
    });
    await db.query('DELETE FROM webauthn_challenges WHERE purpose = $1', ['register']);
    await db.query('INSERT INTO webauthn_challenges (challenge, purpose) VALUES ($1, $2)', [
      options.challenge,
      'register',
    ]);
    // The library leaves user.id as a raw Buffer rather than a JSON-safe
    // string; convert it so the browser receives valid base64url.
    options.user.id = Buffer.from(options.user.id).toString('base64url');
    res.json(options);
  } catch (err) { next(err); }
});

app.post('/api/admin/webauthn/register', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT challenge FROM webauthn_challenges WHERE purpose = $1 ORDER BY id DESC LIMIT 1',
      ['register']
    );
    const row = rows[0];
    if (!row) return res.status(400).json({ error: 'No pending registration' });

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: row.challenge,
      expectedOrigin: originFromReq(req),
      expectedRPID: rpIDFromReq(req),
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Could not verify biometric registration' });
    }
    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    await db.query(
      'INSERT INTO admin_credentials (credential_id, public_key, counter, device_label) VALUES ($1, $2, $3, $4)',
      [
        Buffer.from(credentialID).toString('base64url'),
        Buffer.from(credentialPublicKey).toString('base64url'),
        counter,
        req.body.deviceLabel || 'Kiosk phone',
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/webauthn/login-options', async (req, res, next) => {
  try {
    const { rows: creds } = await db.query('SELECT credential_id FROM admin_credentials');
    if (creds.length === 0) {
      return res.status(404).json({ error: 'No biometric unlock set up yet' });
    }
    const options = await generateAuthenticationOptions({
      rpID: rpIDFromReq(req),
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.credential_id, type: 'public-key' })),
    });
    await db.query('DELETE FROM webauthn_challenges WHERE purpose = $1', ['login']);
    await db.query('INSERT INTO webauthn_challenges (challenge, purpose) VALUES ($1, $2)', [
      options.challenge,
      'login',
    ]);
    res.json(options);
  } catch (err) { next(err); }
});

app.post('/api/admin/webauthn/login', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT challenge FROM webauthn_challenges WHERE purpose = $1 ORDER BY id DESC LIMIT 1',
      ['login']
    );
    const row = rows[0];
    if (!row) return res.status(400).json({ error: 'No pending login' });

    const credentialId = req.body.id;
    const { rows: credRows } = await db.query(
      'SELECT * FROM admin_credentials WHERE credential_id = $1',
      [credentialId]
    );
    const stored = credRows[0];
    if (!stored) return res.status(401).json({ error: 'Unrecognized biometric credential' });

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: row.challenge,
      expectedOrigin: originFromReq(req),
      expectedRPID: rpIDFromReq(req),
      authenticator: {
        credentialID: Buffer.from(stored.credential_id, 'base64url'),
        credentialPublicKey: Buffer.from(stored.public_key, 'base64url'),
        counter: stored.counter,
      },
    });
    if (!verification.verified) {
      return res.status(401).json({ error: 'Biometric verification failed' });
    }
    await db.query('UPDATE admin_credentials SET counter = $1 WHERE id = $2', [
      verification.authenticationInfo.newCounter,
      stored.id,
    ]);
    const token = createSession();
    res.json({ token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/webauthn/status', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, device_label, created_at FROM admin_credentials'
    );
    res.json({ credentials: rows });
  } catch (err) { next(err); }
});

app.delete('/api/admin/webauthn/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM admin_credentials WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- admin: settings ----------

app.get('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    res.json({
      orgName: await db.getSetting('org_name', 'My Company'),
      gracePeriodMinutes: Number(await db.getSetting('grace_period_minutes', 5)),
    });
  } catch (err) { next(err); }
});

app.put('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const { orgName, gracePeriodMinutes } = req.body || {};
    if (orgName !== undefined) await db.setSetting('org_name', orgName);
    if (gracePeriodMinutes !== undefined) await db.setSetting('grace_period_minutes', Number(gracePeriodMinutes));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- admin: staff management ----------

app.get('/api/admin/staff', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, staff_code, name, shift_start, active, created_at FROM staff ORDER BY name'
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/admin/staff', requireAdmin, async (req, res, next) => {
  try {
    const { staffCode, name, pin, shiftStart } = req.body || {};
    if (!staffCode || !name || !pin) {
      return res.status(400).json({ error: 'staffCode, name, and pin are required' });
    }
    const qrToken = crypto.randomBytes(16).toString('hex');
    try {
      const { rows } = await db.query(
        `INSERT INTO staff (staff_code, name, pin_hash, qr_token, shift_start)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [String(staffCode).trim(), name.trim(), db.hashPin(pin), qrToken, shiftStart || '09:00']
      );
      res.json({ id: rows[0].id, qrToken });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'That staff ID is already in use' });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

app.put('/api/admin/staff/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, pin, shiftStart, active } = req.body || {};
    const { rows } = await db.query('SELECT * FROM staff WHERE id = $1', [req.params.id]);
    const staff = rows[0];
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    await db.query(
      `UPDATE staff SET name = $1, pin_hash = $2, shift_start = $3, active = $4 WHERE id = $5`,
      [
        name !== undefined ? name.trim() : staff.name,
        pin ? db.hashPin(pin) : staff.pin_hash,
        shiftStart !== undefined ? shiftStart : staff.shift_start,
        active !== undefined ? (active ? 1 : 0) : staff.active,
        req.params.id,
      ]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/staff/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM attendance WHERE staff_id = $1', [req.params.id]);
    await db.query('DELETE FROM staff WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/admin/staff/:id/qr', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM staff WHERE id = $1', [req.params.id]);
    const staff = rows[0];
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const dataUrl = await QRCode.toDataURL(staff.qr_token, { width: 300, margin: 2 });
    res.json({ dataUrl, staffCode: staff.staff_code, name: staff.name });
  } catch (err) { next(err); }
});

// ---------- admin: shift schedule (imported from Excel) ----------
// Lets departments with rotating shifts (e.g. Customer Service, Risk) upload
// their existing roster spreadsheet directly, instead of an admin re-typing
// it. Expected columns (header names are matched loosely, case-insensitive):
//   Staff ID | Date | Shift Start
// A date cell can be a real Excel date or a "YYYY-MM-DD" string. A shift
// start cell can be a real Excel time, a fraction-of-a-day number, or a
// "HH:MM" / "H:MM AM/PM" string.

function parseDateCell(value) {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number') {
    const ms = Math.round((value - 25569) * 86400 * 1000); // Excel serial -> epoch ms
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
    }
  }
  return null;
}

function parseTimeCell(value) {
  if (value instanceof Date) {
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (typeof value === 'number') {
    const totalMinutes = Math.round(value * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
    if (m) {
      let hh = parseInt(m[1], 10);
      const mm = m[2];
      if (m[3]) {
        const ap = m[3].toUpperCase();
        if (ap === 'PM' && hh !== 12) hh += 12;
        if (ap === 'AM' && hh === 12) hh = 0;
      }
      return `${String(hh).padStart(2, '0')}:${mm}`;
    }
  }
  return null;
}

function findColumn(headers, candidates) {
  return headers.find((h) => {
    const norm = h.toLowerCase().replace(/[^a-z]/g, '');
    return candidates.some((c) => norm.includes(c));
  });
}

app.post('/api/admin/shifts/import', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch (err) {
      return res.status(400).json({ error: 'Could not read that file — is it a valid .xlsx, .xls, or .csv?' });
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    if (!rows.length) return res.status(400).json({ error: 'That sheet looks empty' });

    const headers = Object.keys(rows[0]);
    const staffCol = findColumn(headers, ['staffid', 'staffcode', 'employeeid', 'empid', 'id']);
    const dateCol = findColumn(headers, ['date']);
    const startCol = findColumn(headers, ['shiftstart', 'starttime', 'start']);

    if (!staffCol || !dateCol || !startCol) {
      return res.status(400).json({
        error: `Could not find the expected columns. Found: ${headers.join(', ')}. ` +
          `Expected columns like "Staff ID", "Date", and "Shift Start".`,
      });
    }

    const { rows: staffRows } = await db.query('SELECT id, staff_code FROM staff');
    const staffByCode = new Map(staffRows.map((s) => [String(s.staff_code).trim().toLowerCase(), s.id]));

    const errors = [];
    const validEntries = [];
    rows.forEach((row, i) => {
      const rowNum = i + 2; // +1 for header row, +1 for 1-indexing
      const staffCode = row[staffCol] == null ? '' : String(row[staffCol]).trim();
      const staffId = staffByCode.get(staffCode.toLowerCase());
      const dateStr = parseDateCell(row[dateCol]);
      const timeStr_ = parseTimeCell(row[startCol]);

      if (!staffCode) { errors.push(`Row ${rowNum}: missing Staff ID`); return; }
      if (!staffId) { errors.push(`Row ${rowNum}: no staff found with ID "${staffCode}"`); return; }
      if (!dateStr) { errors.push(`Row ${rowNum}: could not read the date`); return; }
      if (!timeStr_) { errors.push(`Row ${rowNum}: could not read the shift start time`); return; }

      validEntries.push({ staffId, dateStr, timeStr_ });
    });

    for (const e of validEntries) {
      await db.query(
        `INSERT INTO staff_shifts (staff_id, shift_date, shift_start) VALUES ($1, $2, $3)
         ON CONFLICT (staff_id, shift_date) DO UPDATE SET shift_start = excluded.shift_start`,
        [e.staffId, e.dateStr, e.timeStr_]
      );
    }

    res.json({
      imported: validEntries.length,
      staffCount: new Set(validEntries.map((e) => e.staffId)).size,
      errorCount: errors.length,
      errors: errors.slice(0, 30),
    });
  } catch (err) { next(err); }
});

app.get('/api/admin/shifts', requireAdmin, async (req, res, next) => {
  try {
    const from = req.query.from || todayStr();
    const to = req.query.to || todayStr(new Date(Date.now() + 13 * 86400000));
    const { rows } = await db.query(
      `SELECT ss.id, ss.shift_date, ss.shift_start, s.id as staff_id, s.name, s.staff_code
       FROM staff_shifts ss JOIN staff s ON s.id = ss.staff_id
       WHERE ss.shift_date BETWEEN $1 AND $2
       ORDER BY ss.shift_date, s.name`,
      [from, to]
    );
    res.json({ from, to, rows });
  } catch (err) { next(err); }
});

app.delete('/api/admin/shifts/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM staff_shifts WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- admin: attendance ----------

app.get('/api/admin/attendance', requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const { rows } = await db.query(
      `SELECT a.id, a.work_date, a.check_in_at, a.method, a.status, a.minutes_late,
              s.id as staff_id, s.name, s.staff_code, s.shift_start
       FROM attendance a JOIN staff s ON s.id = a.staff_id
       WHERE a.work_date = $1
       ORDER BY a.check_in_at`,
      [date]
    );

    const { rows: allStaff } = await db.query(
      'SELECT id, name, staff_code, shift_start FROM staff WHERE active = 1'
    );
    const { rows: overridesForDate } = await db.query(
      'SELECT staff_id, shift_start FROM staff_shifts WHERE shift_date = $1',
      [date]
    );
    const overrideMap = new Map(overridesForDate.map((o) => [o.staff_id, o.shift_start]));

    const checkedInIds = new Set(rows.map((r) => r.staff_id));
    const absent = allStaff
      .filter((s) => !checkedInIds.has(s.id))
      .map((s) => ({ ...s, shift_start: overrideMap.get(s.id) || s.shift_start }));

    res.json({ date, checkedIn: rows, absent });
  } catch (err) { next(err); }
});

app.get('/api/admin/attendance/summary', requireAdmin, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const start = from || todayStr(new Date(Date.now() - 29 * 86400000));
    const end = to || todayStr();
    const { rows } = await db.query(
      `SELECT s.id as staff_id, s.name, s.staff_code,
              COUNT(*) as days_checked_in,
              SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) as days_late,
              AVG(a.minutes_late) as avg_minutes_late
       FROM attendance a JOIN staff s ON s.id = a.staff_id
       WHERE a.work_date BETWEEN $1 AND $2
       GROUP BY s.id, s.name, s.staff_code
       ORDER BY days_late DESC`,
      [start, end]
    );
    // node-postgres returns COUNT/SUM/AVG as strings (bigint/numeric),
    // not JS numbers — coerce before sending to the frontend.
    const normalized = rows.map((r) => ({
      ...r,
      days_checked_in: Number(r.days_checked_in),
      days_late: Number(r.days_late),
      avg_minutes_late: r.avg_minutes_late === null ? 0 : Number(r.avg_minutes_late),
    }));
    res.json({ from: start, to: end, rows: normalized });
  } catch (err) { next(err); }
});

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
