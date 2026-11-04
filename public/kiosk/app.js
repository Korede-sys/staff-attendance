QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js';

const clockEl = document.getElementById('clock');
function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleString([], {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
}
setInterval(tickClock, 1000);
tickClock();

// ---- load org name ----
fetch('/api/public/settings')
  .then((r) => r.json())
  .then((s) => {
    if (s.orgName) document.getElementById('org-name').textContent = s.orgName + ' — Check-In';
  })
  .catch(() => {});

// ---- tabs ----
const tabs = document.querySelectorAll('.tab');
const panels = {
  qr: document.getElementById('panel-qr'),
  pin: document.getElementById('panel-pin'),
};
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    Object.values(panels).forEach((p) => p.classList.remove('active'));
    panels[tab.dataset.tab].classList.add('active');
    if (tab.dataset.tab === 'qr') startScanner();
    else stopScanner();
  });
});

// ---- overlay ----
const overlay = document.getElementById('overlay');
const overlayIcon = document.getElementById('overlay-icon');
const overlayName = document.getElementById('overlay-name');
const overlayStatus = document.getElementById('overlay-status');
const overlayDetail = document.getElementById('overlay-detail');
let overlayTimer = null;

function showResult({ kind, name, statusText, detail }) {
  overlay.className = 'show ' + kind;
  overlayIcon.textContent = kind === 'on_time' ? '✅' : kind === 'late' ? '⏰' : '⚠️';
  overlayName.textContent = name || '';
  overlayStatus.textContent = statusText;
  overlayDetail.textContent = detail || '';
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => {
    overlay.className = '';
  }, 3200);
}

function handleCheckInResponse(data, ok) {
  if (!ok) {
    showResult({ kind: 'error', name: '', statusText: data.error || 'Check-in failed', detail: 'Please try again' });
    return;
  }
  if (data.alreadyCheckedIn) {
    showResult({ kind: 'on_time', name: data.name, statusText: 'Already checked in today', detail: '' });
    return;
  }
  if (data.status === 'late') {
    showResult({
      kind: 'late',
      name: data.name,
      statusText: `Late by ${data.minutesLate} min`,
      detail: `Checked in at ${data.time}`,
    });
  } else {
    showResult({
      kind: 'on_time',
      name: data.name,
      statusText: 'On time',
      detail: `Checked in at ${data.time}`,
    });
  }
}

// ---- QR scanning ----
let scanner = null;
let scanLocked = false;

function startScanner() {
  const videoEl = document.getElementById('qr-video');
  if (!scanner) {
    scanner = new QrScanner(
      videoEl,
      (result) => onQrDetected(result.data || result),
      { highlightScanRegion: true, highlightCodeOutline: true, maxScansPerSecond: 5 }
    );
  }
  scanner.start().catch((err) => {
    showResult({ kind: 'error', name: '', statusText: 'Camera unavailable', detail: String(err.message || err) });
  });
}
function stopScanner() {
  if (scanner) scanner.stop();
}

async function onQrDetected(token) {
  if (scanLocked) return;
  scanLocked = true;
  try {
    const res = await fetch('/api/checkin/qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    handleCheckInResponse(data, res.ok);
  } catch (err) {
    showResult({ kind: 'error', name: '', statusText: 'Network error', detail: 'Check connection to server' });
  } finally {
    setTimeout(() => { scanLocked = false; }, 2500);
  }
}

// start on load since QR tab is active by default
startScanner();

// ---- PIN keypad ----
const staffCodeEl = document.getElementById('staff-code');
const staffPinEl = document.getElementById('staff-pin');
let activeField = 'code';
let codeValue = '';
let pinValue = '';

staffCodeEl.addEventListener('click', () => { activeField = 'code'; });
staffPinEl.addEventListener('click', () => { activeField = 'pin'; });

const keypad = document.getElementById('keypad');
const keys = ['1','2','3','4','5','6','7','8','9','⌫','0','OK'];
keys.forEach((k) => {
  const btn = document.createElement('button');
  btn.textContent = k;
  btn.addEventListener('click', () => onKeyPress(k));
  keypad.appendChild(btn);
});

function onKeyPress(k) {
  if (k === '⌫') {
    if (activeField === 'code') codeValue = codeValue.slice(0, -1);
    else pinValue = pinValue.slice(0, -1);
  } else if (k === 'OK') {
    if (activeField === 'code' && codeValue.length > 0) activeField = 'pin';
    else submitPin();
    return;
  } else {
    if (activeField === 'code' && codeValue.length < 10) codeValue += k;
    else if (activeField === 'pin' && pinValue.length < 8) pinValue += k;
  }
  staffCodeEl.value = codeValue;
  staffPinEl.value = pinValue;
}

document.getElementById('submit-pin').addEventListener('click', submitPin);

async function submitPin() {
  if (!codeValue || !pinValue) {
    showResult({ kind: 'error', name: '', statusText: 'Enter Staff ID and PIN', detail: '' });
    return;
  }
  try {
    const res = await fetch('/api/checkin/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffCode: codeValue, pin: pinValue }),
    });
    const data = await res.json();
    handleCheckInResponse(data, res.ok);
  } catch (err) {
    showResult({ kind: 'error', name: '', statusText: 'Network error', detail: 'Check connection to server' });
  } finally {
    codeValue = '';
    pinValue = '';
    staffCodeEl.value = '';
    staffPinEl.value = '';
    activeField = 'code';
  }
}
