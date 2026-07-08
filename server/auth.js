import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db.js';

// Persistent signing secret so sessions survive restarts.
const secretFile = path.join(DATA_DIR, 'secret');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') {
  console.warn('[auth] WARNING: using default admin password "changeme". Set ADMIN_PASSWORD env var in production.');
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}

export function makeSessionCookie() {
  return `admin.${sign('admin-session')}`;
}

export function isValidSession(cookieValue) {
  if (!cookieValue) return false;
  const expected = makeSessionCookie();
  return cookieValue.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(cookieValue), Buffer.from(expected));
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isAdminRequest(req) {
  return isValidSession(parseCookies(req.headers.cookie).sb_admin);
}

export function requireAdmin(req, res, next) {
  if (isAdminRequest(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
