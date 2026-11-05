// ---------- base64url <-> ArrayBuffer helpers (for WebAuthn) ----------
function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLen);
  const str = atob(padded);
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
  return buf.buffer;
}

// ---------- session ----------
let token = sessionStorage.getItem('admin_token') || null;

function apiFetch(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, token ? { Authorization: 'Bearer ' + token } : {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  return fetch(url, opts).then(async (res) => {
    if (res.status === 401) {
      logout();
      throw new Error('Session expired, please sign in again');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  loadSettingsIntoBrand();
  switchView('today');
}
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
}
function logout() {
  token = null;
  sessionStorage.removeItem('admin_token');
  showLogin();
}

document.getElementById('logout-btn').addEventListener('click', logout);

// ---------- dark mode ----------
const themeToggleBtn = document.getElementById('theme-toggle-btn');
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  if (themeToggleBtn) themeToggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('admin_theme'); } catch (e) {}
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
})();
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const next = document.body.classList.contains('dark') ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('admin_theme', next); } catch (e) {}
  });
}

// ---------- login ----------
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const pin = document.getElementById('login-pin').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token;
    sessionStorage.setItem('admin_token', token);
    if (data.mustChangePin) {
      errEl.style.color = '#ea580c';
      errEl.textContent = 'Using the default PIN (1234) — please change it in Settings.';
    }
    showApp();
  } catch (err) {
    errEl.style.color = '';
    errEl.textContent = err.message;
  }
}

// biometric login (if this device already has a credential registered)
const bioBtn = document.getElementById('biometric-login-btn');
fetch('/api/admin/webauthn/login-options')
  .then((r) => { if (r.ok) bioBtn.style.display = 'block'; })
  .catch(() => {});

bioBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const optRes = await fetch('/api/admin/webauthn/login-options');
    const options = await optRes.json();
    if (!optRes.ok) throw new Error(options.error);

    const publicKey = Object.assign({}, options, {
      challenge: base64urlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({
        ...c,
        id: base64urlToBuffer(c.id),
      })),
    });
    const cred = await navigator.credentials.get({ publicKey });
    const payload = {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: bufferToBase64url(cred.response.authenticatorData),
        clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
        signature: bufferToBase64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufferToBase64url(cred.response.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    const verifyRes = await fetch('/api/admin/webauthn/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) throw new Error(verifyData.error);
    token = verifyData.token;
    sessionStorage.setItem('admin_token', token);
    showApp();
  } catch (err) {
    errEl.textContent = 'Biometric unlock failed: ' + err.message;
  }
});

// ---------- nav ----------
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

function switchView(view) {
  document.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'today') loadToday();
  if (view === 'staff') loadStaff();
  if (view === 'shifts') loadShiftsDefaults();
  if (view === 'reports') loadReportDefaults();
  if (view === 'settings') loadSettings();
}

function loadSettingsIntoBrand() {
  apiFetch('/api/admin/settings').then((s) => {
    document.getElementById('brand-name').textContent = s.orgName + ' — Admin';
  }).catch(() => {});
}

// ---------- today view ----------
const dateInput = document.getElementById('attendance-date');
dateInput.value = new Date().toISOString().slice(0, 10);
dateInput.addEventListener('change', loadToday);

async function loadToday() {
  try {
    const data = await apiFetch('/api/admin/attendance?date=' + dateInput.value);
    document.getElementById('checked-in-count').textContent = data.checkedIn.length;
    document.getElementById('absent-count').textContent = data.absent.length;

    const body1 = document.querySelector('#checked-in-table tbody');
    body1.innerHTML = data.checkedIn.map((r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.staff_code)}</td>
        <td>${new Date(r.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${r.method.toUpperCase()}</td>
        <td class="status-${r.status}">${r.status === 'late' ? 'Late (' + r.minutes_late + 'm)' : 'On time'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No check-ins yet</td></tr>';

    const body2 = document.querySelector('#absent-table tbody');
    body2.innerHTML = data.absent.map((s) => `
      <tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.staff_code)}</td><td>${s.shift_start}</td></tr>
    `).join('') || '<tr><td colspan="3" class="muted">Everyone has checked in</td></tr>';
  } catch (err) { console.error(err); }
}

// ---------- staff view ----------
async function loadStaff() {
  try {
    const staff = await apiFetch('/api/admin/staff');
    const body = document.querySelector('#staff-table tbody');
    body.innerHTML = staff.map((s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.staff_code)}</td>
        <td>${s.shift_start}</td>
        <td>${s.active ? 'Yes' : 'No'}</td>
        <td>
          <button class="btn ghost small" onclick="openEditStaff(${s.id})">✏️ Edit</button>
          <button class="btn ghost small" onclick="openStaffQr(${s.id})">📷 QR code</button>
          <button class="btn danger small" onclick="deleteStaff(${s.id}, '${escapeHtml(s.name)}')">🗑️ Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No staff yet</td></tr>';
  } catch (err) { console.error(err); }
}

document.getElementById('add-staff-btn').addEventListener('click', () => openStaffForm());

function openStaffForm(staff) {
  const isEdit = !!staff;
  showModal(`
    <h3>${isEdit ? '✏️ Edit Staff' : '➕ Add Staff'}</h3>
    <div class="field"><label>Full name</label><input id="f-name" value="${staff ? escapeHtml(staff.name) : ''}" /></div>
    <div class="field"><label>Staff ID (used for PIN check-in)</label><input id="f-code" ${isEdit ? 'disabled' : ''} value="${staff ? escapeHtml(staff.staff_code) : ''}" /></div>
    <div class="field"><label>${isEdit ? 'New PIN (leave blank to keep current)' : 'PIN'}</label><input id="f-pin" type="password" inputmode="numeric" /></div>
    <div class="field"><label>Shift start time</label><input id="f-shift" type="time" value="${staff ? staff.shift_start : '09:00'}" /></div>
    ${isEdit ? `<div class="field"><label><input type="checkbox" id="f-active" ${staff.active ? 'checked' : ''} /> Active</label></div>` : ''}
    <div class="error-text" id="form-error"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">✖️ Cancel</button>
      <button class="btn primary" id="save-staff-btn">${isEdit ? '💾 Save' : '➕ Create'}</button>
    </div>
  `);
  document.getElementById('save-staff-btn').addEventListener('click', () => saveStaff(staff ? staff.id : null));
}

window.openEditStaff = async (id) => {
  const staff = await apiFetch('/api/admin/staff').then((list) => list.find((s) => s.id === id));
  openStaffForm(staff);
};

async function saveStaff(id) {
  const name = document.getElementById('f-name').value.trim();
  const shiftStart = document.getElementById('f-shift').value;
  const pin = document.getElementById('f-pin').value;
  const errEl = document.getElementById('form-error');
  try {
    if (id) {
      const active = document.getElementById('f-active').checked;
      await apiFetch('/api/admin/staff/' + id, { method: 'PUT', body: { name, shiftStart, pin: pin || undefined, active } });
    } else {
      const staffCode = document.getElementById('f-code').value.trim();
      if (!name || !staffCode || !pin) throw new Error('Name, Staff ID, and PIN are required');
      await apiFetch('/api/admin/staff', { method: 'POST', body: { name, staffCode, pin, shiftStart } });
    }
    closeModal();
    loadStaff();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

window.deleteStaff = async (id, name) => {
  if (!confirm(`Delete ${name}? This also removes their attendance history.`)) return;
  await apiFetch('/api/admin/staff/' + id, { method: 'DELETE' });
  loadStaff();
};

window.openStaffQr = async (id) => {
  const data = await apiFetch('/api/admin/staff/' + id + '/qr');
  showModal(`
    <h3>📷 ${escapeHtml(data.name)}'s QR Code</h3>
    <p class="muted">Print this and give it to the staff member, or let them save it to their phone to scan at the kiosk.</p>
    <div class="qr-preview"><img src="${data.dataUrl}" /></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">✖️ Close</button>
      <button class="btn primary" onclick="printQr('${data.dataUrl}', '${escapeHtml(data.name)}')">🖨️ Print</button>
    </div>
  `);
};

window.printQr = (dataUrl, name) => {
  const w = window.open('', '_blank');
  w.document.write(`<html><body style="text-align:center;font-family:sans-serif;">
    <h2>${name}</h2><img src="${dataUrl}" style="width:300px;" /></body></html>`);
  w.document.close();
  w.print();
};

// ---------- shifts view (rotating schedules imported from Excel) ----------
function loadShiftsDefaults() {
  const from = document.getElementById('shifts-from');
  const to = document.getElementById('shifts-to');
  if (!from.value) from.value = new Date().toISOString().slice(0, 10);
  if (!to.value) to.value = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10);
  loadShifts();
}

document.getElementById('load-shifts-btn').addEventListener('click', loadShifts);

async function loadShifts() {
  const from = document.getElementById('shifts-from').value;
  const to = document.getElementById('shifts-to').value;
  const data = await apiFetch(`/api/admin/shifts?from=${from}&to=${to}`);
  const body = document.querySelector('#shifts-table tbody');
  body.innerHTML = data.rows.map((r) => `
    <tr>
      <td>${r.shift_date}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.staff_code)}</td>
      <td>${r.shift_start}</td>
      <td><button class="btn danger small" onclick="deleteShiftRow(${r.id})">🗑️</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No imported shifts in this range</td></tr>';
}

window.deleteShiftRow = async (id) => {
  await apiFetch('/api/admin/shifts/' + id, { method: 'DELETE' });
  loadShifts();
};

document.getElementById('import-shifts-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('shift-file-input');
  const resultEl = document.getElementById('import-result');
  const errorsEl = document.getElementById('import-errors');
  resultEl.style.color = '';
  resultEl.textContent = '';
  errorsEl.innerHTML = '';

  const file = fileInput.files[0];
  if (!file) {
    resultEl.style.color = '#dc2626';
    resultEl.textContent = 'Choose a file first';
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/admin/shifts/import', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');

    resultEl.style.color = '';
    resultEl.textContent = `✅ Imported ${data.imported} shift entries for ${data.staffCount} staff member(s).` +
      (data.errorCount ? ` ${data.errorCount} row(s) had problems.` : '');
    errorsEl.innerHTML = (data.errors || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('');
    fileInput.value = '';
    loadShifts();
  } catch (err) {
    resultEl.style.color = '#dc2626';
    resultEl.textContent = err.message;
  }
});

document.getElementById('download-template-btn').addEventListener('click', () => {
  const csv = 'Staff ID,Date,Shift Start\r\nEMP001,2026-11-10,14:00\r\nEMP002,2026-11-10,07:00\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shift-schedule-template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------- reports view ----------
function loadReportDefaults() {
  const to = document.getElementById('report-to');
  const from = document.getElementById('report-from');
  if (!to.value) to.value = new Date().toISOString().slice(0, 10);
  if (!from.value) from.value = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
}
document.getElementById('run-report-btn').addEventListener('click', runReport);
document.getElementById('export-report-btn').addEventListener('click', exportReportCsv);

let lastReportRows = [];
let lastReportRange = { from: '', to: '' };

async function runReport() {
  const from = document.getElementById('report-from').value;
  const to = document.getElementById('report-to').value;
  const data = await apiFetch(`/api/admin/attendance/summary?from=${from}&to=${to}`);
  lastReportRows = data.rows || [];
  lastReportRange = { from, to };
  const body = document.querySelector('#report-table tbody');
  body.innerHTML = lastReportRows.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.staff_code)}</td>
      <td>${r.days_checked_in}</td>
      <td>${r.days_late}</td>
      <td>${r.avg_minutes_late ? Math.round(r.avg_minutes_late) : 0}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No data in this range</td></tr>';
}

function exportReportCsv() {
  if (!lastReportRows.length) {
    alert('Run a report first, then export.');
    return;
  }
  const header = ['Name', 'Staff ID', 'Days checked in', 'Days late', 'Avg minutes late'];
  const csvRows = [header.join(',')];
  lastReportRows.forEach((r) => {
    const row = [
      r.name,
      r.staff_code,
      r.days_checked_in,
      r.days_late,
      r.avg_minutes_late ? Math.round(r.avg_minutes_late) : 0,
    ].map(csvEscape);
    csvRows.push(row.join(','));
  });
  const csvContent = csvRows.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lateness-report_${lastReportRange.from}_to_${lastReportRange.to}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// ---------- settings view ----------
async function loadSettings() {
  const s = await apiFetch('/api/admin/settings');
  document.getElementById('org-name-input').value = s.orgName;
  document.getElementById('grace-input').value = s.gracePeriodMinutes;
  loadBiometricList();
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const orgName = document.getElementById('org-name-input').value.trim();
  const gracePeriodMinutes = Number(document.getElementById('grace-input').value);
  await apiFetch('/api/admin/settings', { method: 'PUT', body: { orgName, gracePeriodMinutes } });
  document.getElementById('settings-saved').textContent = 'Saved';
  loadSettingsIntoBrand();
  setTimeout(() => { document.getElementById('settings-saved').textContent = ''; }, 2000);
});

document.getElementById('change-pin-btn').addEventListener('click', async () => {
  const newPin = document.getElementById('new-pin-input').value;
  const el = document.getElementById('pin-changed');
  try {
    await apiFetch('/api/admin/change-pin', { method: 'POST', body: { newPin } });
    el.style.color = '';
    el.textContent = 'PIN updated';
    document.getElementById('new-pin-input').value = '';
  } catch (err) {
    el.style.color = '#dc2626';
    el.textContent = err.message;
  }
});

async function loadBiometricList() {
  const data = await apiFetch('/api/admin/webauthn/status');
  const list = document.getElementById('biometric-list');
  list.innerHTML = data.credentials.map((c) => `
    <li><span>👆 ${escapeHtml(c.device_label || 'Device')} — added ${new Date(c.created_at).toLocaleDateString()}</span>
    <button class="btn danger small" onclick="deleteBiometric(${c.id})">🗑️ Remove</button></li>
  `).join('') || '<li class="muted">None set up yet</li>';
}

window.deleteBiometric = async (id) => {
  await apiFetch('/api/admin/webauthn/' + id, { method: 'DELETE' });
  loadBiometricList();
};

document.getElementById('register-biometric-btn').addEventListener('click', async () => {
  const msgEl = document.getElementById('biometric-msg');
  msgEl.style.color = '';
  msgEl.textContent = '';
  try {
    const options = await apiFetch('/api/admin/webauthn/register-options');
    const publicKey = Object.assign({}, options, {
      challenge: base64urlToBuffer(options.challenge),
      user: Object.assign({}, options.user, { id: base64urlToBuffer(options.user.id) }),
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
    });
    const cred = await navigator.credentials.create({ publicKey });
    const payload = {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: bufferToBase64url(cred.response.attestationObject),
        clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      deviceLabel: navigator.userAgent.match(/iPhone|iPad|Android/) ? 'This phone' : 'This device',
    };
    await apiFetch('/api/admin/webauthn/register', { method: 'POST', body: payload });
    msgEl.textContent = 'Biometric unlock set up on this device';
    loadBiometricList();
  } catch (err) {
    msgEl.style.color = '#dc2626';
    msgEl.textContent = 'Setup failed: ' + err.message;
  }
});

// ---------- modal ----------
function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-backdrop').style.display = 'flex';
}
window.closeModal = () => { document.getElementById('modal-backdrop').style.display = 'none'; };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ---------- boot ----------
if (token) showApp(); else showLogin();
