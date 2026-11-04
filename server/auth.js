const jwt = require('jsonwebtoken');

// Serverless functions don't share memory between invocations (each
// request may land on a different instance), so admin sessions can't be
// kept in a server-side map like a traditional long-running process. A
// signed, stateless JWT replaces that: the token itself carries proof the
// holder logged in with the right PIN or biometric, verified fresh on
// every request without needing shared storage.
const SESSION_TTL = '8h';

const SECRET = process.env.ADMIN_JWT_SECRET;
if (!SECRET) {
  throw new Error(
    'ADMIN_JWT_SECRET is not set. Set it to a long random string in your environment ' +
    '(e.g. `openssl rand -hex 32`) before starting the server.'
  );
}

function createSession() {
  return jwt.sign({ role: 'admin' }, SECRET, { expiresIn: SESSION_TTL });
}

function isValidSession(token) {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, SECRET);
    return payload && payload.role === 'admin';
  } catch (err) {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

module.exports = { createSession, isValidSession, requireAdmin };
