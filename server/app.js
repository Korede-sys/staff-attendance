const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const QRCode = require('qrcode');
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

async function recordCheckIn(staff, method) {
  const now = new Date();
  const date = todayStr(now);
  const nowTime = timeStr(now);
  const shiftMinutes = minutesSinceMidnight(staff.shift_start);
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
    const checkedInIds = new Set(rows.map((r) => r.staff_id));
    const absent = allStaff.filter((s) => !checkedInIds.has(s.id));

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
