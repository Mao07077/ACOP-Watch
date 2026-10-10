const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { MongoClient, ObjectId } = require('mongodb');
const webpush = require('web-push');
const XLSX = require('xlsx');

dotenv.config();

const port = Number(process.env.PORT || 3000);
const databaseName = process.env.MONGODB_DB_NAME || 'acopwatch';
const client = new MongoClient(process.env.MONGODB_URI || '');
const publicDir = __dirname;
let clients;
let pushSubscriptions;
let notificationRuns;
let users;
let sessions;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

function getPensionCategory(type) {
  const normalized = String(type || '').toUpperCase();
  if (normalized.includes('RT')) return 'RT';
  if (normalized.includes('ST')) return 'ST';
  if (normalized.includes('SD')) return 'SD';
  return 'Other';
}

function isGsisPension(type) {
  return String(type || '').toUpperCase().includes('GSIS');
}

function getAge(dateValue) {
  if (!dateValue) return null;
  const birthDate = new Date(dateValue);
  if (Number.isNaN(birthDate.valueOf())) return null;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const birthday = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  if (birthday > today) age -= 1;
  return age;
}

function getMonthName(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

function addAcopSchedule(client) {
  const category = getPensionCategory(client.type);
  const gsisPension = isGsisPension(client.type);
  const memberBirthday = client.memberBirthday || client.sourceData?.['MEMBERS B-DAY'] || client.sourceData?.['MEMBER\'S B-DAY'];
  const pensionerBirthday = client.sourceData?.BIRTHDAY || client.date;
  const scheduleDate = gsisPension ? pensionerBirthday : (memberBirthday || pensionerBirthday);
  const age = getAge(pensionerBirthday);
  return {
    ...client,
    acopCategory: category,
    acopScheduleDate: scheduleDate || null,
    acopScheduleMonth: getMonthName(scheduleDate),
    acopScheduleReason: gsisPension ? 'Pensioner birthday · APIR yearly' : (memberBirthday ? 'Member birthday' : 'Pensioner birthday fallback'),
    acopFrequency: gsisPension ? 'Yearly' : null,
    apirRequired: gsisPension,
    pensionerAge: age,
    acopEligible: gsisPension || category !== 'RT' || (age !== null && age >= 80)
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, derivedKey) => error ? reject(error) : resolve(`${salt}:${derivedKey.toString('hex')}`)));
}

async function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(':');
  const actual = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(actual.split(':')[1], 'hex'), Buffer.from(expected, 'hex'));
}

async function getSessionUser(request) {
  const token = parseCookies(request).acop_session;
  if (!token) return null;
  const session = await sessions.findOne({ token });
  if (!session || session.expiresAt <= new Date()) return null;
  return users.findOne({ _id: session.userId }, { projection: { passwordHash: 0 } });
}

function setSessionCookie(response, token) {
  response.setHeader('Set-Cookie', `acop_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'acop_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function userBranchId(user) {
  return String(user.username || '').trim().toLowerCase();
}

function clientScope(user) {
  return user.role === 'admin' ? {} : { branchId: userBranchId(user) };
}

function canAccessClient(user, record) {
  return user.role === 'admin' || record.branchId === userBranchId(user);
}

function parseMultipartFile(request, body) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=("(?:[^"]+)"|[^;]+)/i);
  if (!boundaryMatch) throw new Error('A multipart form upload is required.');
  const boundary = Buffer.from(`--${boundaryMatch[1].replace(/^"|"$/g, '')}`);
  const start = body.indexOf(Buffer.from('\r\n\r\n'));
  if (start < 0) throw new Error('The uploaded file is missing.');
  const header = body.subarray(0, start).toString('utf8');
  const filenameMatch = header.match(/filename="([^"]+)"/i);
  if (!filenameMatch) throw new Error('Choose an Excel file to upload.');
  const fileStart = start + 4;
  const fileEnd = body.indexOf(boundary, fileStart) - 2;
  if (fileEnd <= fileStart) throw new Error('The uploaded file is empty.');
  return { filename: filenameMatch[1], buffer: body.subarray(fileStart, fileEnd) };
}

function spreadsheetDate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    return date ? `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}` : '';
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value).trim() : date.toISOString().slice(0, 10);
}

function spreadsheetText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function spreadsheetIdentifierKey(value) {
  return spreadsheetText(value).replace(/\D/g, '');
}

async function readRequestBody(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('The Excel file must be 10 MB or smaller.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function requireUser(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Please log in to continue.' });
    return null;
  }
  return user;
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function getDailyNotificationCounts(records) {
  const now = new Date();
  const currentMonth = now.getUTCMonth();
  const eligible = records.filter((record) => record.status === 'for-acop' && record.acopEligible !== false);
  const due = eligible.filter((record) => {
    const date = record.acopScheduleDate ? new Date(record.acopScheduleDate) : null;
    return date && !Number.isNaN(date.valueOf()) && date.getUTCMonth() === currentMonth;
  }).length;
  const overdue = eligible.filter((record) => {
    const date = record.acopScheduleDate ? new Date(record.acopScheduleDate) : null;
    return date && !Number.isNaN(date.valueOf()) && date.getUTCMonth() < currentMonth;
  }).length;
  return { due, overdue };
}

async function sendDailyPushNotification() {
  if (!webpush || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const dayKey = new Intl.DateTimeFormat('en-CA').format(new Date());
  try {
    await notificationRuns.createIndex({ dayKey: 1 }, { unique: true });
    await notificationRuns.insertOne({ dayKey, sentAt: new Date() });
  } catch (error) {
    if (error.code === 11000) return;
    throw error;
  }
  const records = (await clients.find({}).toArray()).map(addAcopSchedule);
  const { due, overdue } = getDailyNotificationCounts(records);
  const body = due && overdue
    ? `${due} due this month and ${overdue} overdue clients need attention.`
    : due
      ? `${due} client${due === 1 ? '' : 's'} need ACOP/APIR this month.`
      : overdue
        ? `${overdue} overdue client${overdue === 1 ? '' : 's'} need follow-up.`
        : 'No due or overdue ACOP/APIR records today.';
  const subscriptions = await pushSubscriptions.find({}).toArray();
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({ title: 'ACOP Watch daily reminder', body, url: '/' }));
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) await pushSubscriptions.deleteOne({ _id: subscription._id });
      else console.error('Push notification failed:', error.message);
    }
  }));
}

function startNotificationScheduler() {
  const hour = Number(process.env.NOTIFICATION_HOUR || 9);
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === hour && now.getMinutes() === 0) sendDailyPushNotification().catch((error) => console.error('Daily notification failed:', error.message));
  }, 60 * 1000);
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/auth/setup-status' && request.method === 'GET') {
    return sendJson(response, 200, { needsSetup: await users.countDocuments() === 0 });
  }
  if (url.pathname === '/api/auth/setup' && request.method === 'POST') {
    if (await users.countDocuments()) return sendJson(response, 409, { error: 'Initial setup is already complete.' });
    const input = await readBody(request);
    if (!input.username?.trim() || !input.password || input.password.length < 8) return sendJson(response, 400, { error: 'Username and a password of at least 8 characters are required.' });
    const passwordHash = await hashPassword(input.password);
    await users.insertOne({ username: input.username.trim().toLowerCase(), displayName: input.displayName?.trim() || 'Administrator', role: 'admin', branchId: null, passwordHash, createdAt: new Date() });
    return sendJson(response, 201, { created: true });
  }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const input = await readBody(request);
    const user = await users.findOne({ username: String(input.username || '').trim().toLowerCase() });
    if (!user || !(await verifyPassword(String(input.password || ''), user.passwordHash))) return sendJson(response, 401, { error: 'Invalid username or password.' });
    const token = crypto.randomBytes(32).toString('hex');
    await sessions.insertOne({ token, userId: user._id, createdAt: new Date(), expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) });
    setSessionCookie(response, token);
    return sendJson(response, 200, { user: { username: user.username, displayName: user.displayName, role: user.role, branchId: user.branchId } });
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = parseCookies(request).acop_session;
    if (token) await sessions.deleteOne({ token });
    clearSessionCookie(response);
    return sendJson(response, 200, { loggedOut: true });
  }
  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await getSessionUser(request);
    return sendJson(response, 200, { user: user ? { username: user.username, displayName: user.displayName, role: user.role, branchId: user.branchId } : null });
  }
  const protectedUser = await requireUser(request, response);
  if (!protectedUser) return;
  if (url.pathname === '/api/notifications/config' && request.method === 'GET') {
    return sendJson(response, 200, { publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }
  if (url.pathname === '/api/notifications/subscribe' && request.method === 'POST') {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return sendJson(response, 503, { error: 'Push notifications are not configured on the server.' });
    const subscription = await readBody(request);
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return sendJson(response, 400, { error: 'Invalid push subscription.' });
    await pushSubscriptions.updateOne({ endpoint: subscription.endpoint }, { $set: { ...subscription, updatedAt: new Date() } }, { upsert: true });
    return sendJson(response, 201, { subscribed: true });
  }
  if (url.pathname === '/api/notifications/subscribe' && request.method === 'DELETE') {
    const subscription = await readBody(request);
    if (subscription?.endpoint) await pushSubscriptions.deleteOne({ endpoint: subscription.endpoint });
    return sendJson(response, 200, { unsubscribed: true });
  }
  if (url.pathname === '/api/clients' && request.method === 'GET') {
    const records = await clients.find(clientScope(protectedUser)).sort({ name: 1 }).toArray();
    return sendJson(response, 200, records.map(addAcopSchedule));
  }

  if (url.pathname === '/api/clients/import' && request.method === 'POST') {
    try {
      const upload = parseMultipartFile(request, await readRequestBody(request));
      if (!/\.(xlsx|xls)$/i.test(upload.filename)) return sendJson(response, 400, { error: 'Only .xlsx or .xls files are supported.' });
      const workbook = XLSX.read(upload.buffer, { type: 'buffer', cellDates: true });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
      const headerIndex = rows.findIndex((row) => row.some((value) => /FULLNAME|BIRTHDAY|PENSION/i.test(spreadsheetText(value))));
      if (headerIndex < 0) return sendJson(response, 400, { error: 'Could not find a client table header in the Excel file.' });
      const headers = rows[headerIndex].map(spreadsheetText);
      const sourceRows = rows.slice(headerIndex + 1).filter((row) => row.some((value) => spreadsheetText(value)));
      const branchId = userBranchId(protectedUser);
      const existingNumbers = new Set((await clients.find(clientScope(protectedUser), { projection: { sub: 1 } }).toArray()).map((record) => spreadsheetIdentifierKey(record.sub)).filter(Boolean));
      const imported = [];
      let skipped = 0;
      for (const row of sourceRows) {
        const sourceData = Object.fromEntries(headers.map((header, index) => [header, spreadsheetText(row[index])]).filter(([header]) => header));
        const name = [sourceData.LASTNAME, sourceData.FIRSTNAME, sourceData.MIDDLENAME].filter(Boolean).join(' ') || sourceData.FULLNAME || '';
        const type = sourceData['TYPE OF PENSION'] || (sourceData['FULLNAME (TYPE OF PENSION) – BANK'] || '').match(/\(([^)]+)\)/)?.[1] || '';
        const date = spreadsheetDate(sourceData.BIRTHDAY);
        const memberBirthday = spreadsheetDate(sourceData["MEMBERS B-DAY"]);
        const sub = sourceData["MEMBER'S SSS/GSIS NUMBER"] || sourceData['PENSIONER SS NO. (FOR SD & ITF)'] || '';
        const contact = sourceData['CELL/TEL NUMBER'] || '';
        const subKey = spreadsheetIdentifierKey(sub);
        if (!name || !type || !date || !sub || !subKey || existingNumbers.has(subKey)) {
          skipped += 1;
          continue;
        }
        const record = {
          name, type, ref: 'ACOP record', date, day: Number(date.slice(-2)), memberBirthday, contact,
          status: 'for-acop', sub, sourceData, branchId, branchName: protectedUser.displayName || protectedUser.username,
          uploadedBy: protectedUser.username, initials: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
          tone: ['mint', 'blue', 'yellow'][imported.length % 3], createdAt: new Date(), updatedAt: new Date()
        };
        imported.push(record);
        existingNumbers.add(subKey);
      }
      if (imported.length) await clients.insertMany(imported);
      return sendJson(response, 201, { imported: imported.length, skipped, totalRows: sourceRows.length, branchId });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'Unable to import the Excel file.' });
    }
  }

  const match = url.pathname.match(/^\/api\/clients\/([a-f0-9]{24})\/status$/);
  if (match && request.method === 'PATCH') {
    const existing = await clients.findOne({ _id: new ObjectId(match[1]) });
    if (!existing) return sendJson(response, 404, { error: 'Client not found.' });
    if (!canAccessClient(protectedUser, existing)) return sendJson(response, 403, { error: 'You can only manage clients assigned to your branch.' });
    const { status, proofUrl } = await readBody(request);
    const allowedStatuses = ['for-acop', 'approval', 'approved', 'overdue'];
    if (!allowedStatuses.includes(status)) return sendJson(response, 400, { error: 'Invalid client status.' });
    if (status === 'approval') {
      let parsedProofUrl;
      try { parsedProofUrl = new URL(String(proofUrl || '')); } catch { return sendJson(response, 400, { error: 'A valid proof image link is required.' }); }
      if (!['http:', 'https:'].includes(parsedProofUrl.protocol)) return sendJson(response, 400, { error: 'Proof link must use http or https.' });
    }
    const result = await clients.findOneAndUpdate(
      { _id: new ObjectId(match[1]) },
      { $set: { status, ...(status === 'approval' ? { proofUrl: String(proofUrl).trim(), proofSubmittedAt: new Date() } : {}), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return sendJson(response, 404, { error: 'Client not found.' });
    return sendJson(response, 200, result);
  }

  const recordMatch = url.pathname.match(/^\/api\/clients\/([a-f0-9]{24})$/);
  if (recordMatch && request.method === 'PATCH') {
    const existing = await clients.findOne({ _id: new ObjectId(recordMatch[1]) });
    if (!existing) return sendJson(response, 404, { error: 'Client not found.' });
    if (!canAccessClient(protectedUser, existing)) return sendJson(response, 403, { error: 'You can only manage clients assigned to your branch.' });
    const input = await readBody(request);
    const allowed = ['name', 'type', 'ref', 'date', 'day', 'contact', 'sub', 'memberBirthday'];
    const updates = Object.fromEntries(allowed.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]));
    if (!updates.name || !updates.type || !updates.ref || !updates.date || !updates.contact || !updates.sub) {
      return sendJson(response, 400, { error: 'Name, pension type, reference, birthday, contact, and SS/GSIS number are required.' });
    }
    updates.day = Number(updates.day);
    if (!Number.isInteger(updates.day) || updates.day < 1 || updates.day > 31) {
      return sendJson(response, 400, { error: 'Birthday must include a valid day.' });
    }
    updates.updatedAt = new Date();
    const result = await clients.findOneAndUpdate(
      { _id: new ObjectId(recordMatch[1]) },
      { $set: updates },
      { returnDocument: 'after' }
    );
    if (!result) return sendJson(response, 404, { error: 'Client not found.' });
    return sendJson(response, 200, result);
  }

  if (recordMatch && request.method === 'DELETE') {
    const existing = await clients.findOne({ _id: new ObjectId(recordMatch[1]) });
    if (!existing) return sendJson(response, 404, { error: 'Client not found.' });
    if (!canAccessClient(protectedUser, existing)) return sendJson(response, 403, { error: 'You can only manage clients assigned to your branch.' });
    const result = await clients.deleteOne({ _id: new ObjectId(recordMatch[1]) });
    if (!result.deletedCount) return sendJson(response, 404, { error: 'Client not found.' });
    return sendJson(response, 200, { deleted: true });
  }

  if (url.pathname === '/api/clients' && request.method === 'POST') {
    const input = await readBody(request);
    const required = ['name', 'type', 'ref', 'date', 'day', 'contact', 'status', 'sub'];
    if (required.some((field) => input[field] === undefined || input[field] === '')) {
      return sendJson(response, 400, { error: 'All client fields are required.' });
    }
    const clientToInsert = {
      ...input,
      branchId: userBranchId(protectedUser),
      branchName: protectedUser.displayName || protectedUser.username,
      uploadedBy: protectedUser.username,
      day: Number(input.day),
      initials: input.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
      tone: ['mint', 'blue', 'yellow'][Math.floor(Math.random() * 3)],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await clients.insertOne(clientToInsert);
    return sendJson(response, 201, { ...clientToInsert, _id: result.insertedId });
  }

  return sendJson(response, 404, { error: 'API route not found.' });
}

async function serve(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    let requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.pathname === '/') {
      const user = await getSessionUser(request);
      if (!user) requested = await users.countDocuments() ? 'login.html' : 'setup.html';
    }
    const filePath = path.resolve(publicDir, requested);
    if (!filePath.startsWith(path.resolve(publicDir)) || filePath === path.resolve(publicDir)) {
      return sendJson(response, 403, { error: 'Forbidden.' });
    }
    const content = await fs.readFile(filePath);
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(response, 404, { error: 'File not found.' });
    console.error('Request failed:', error);
    sendJson(response, 500, { error: 'Unable to process request.' });
  }
}

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing. Copy .env.example to .env and add the database password.');
  await client.connect();
  clients = client.db(databaseName).collection('clients');
  pushSubscriptions = client.db(databaseName).collection('pushSubscriptions');
  notificationRuns = client.db(databaseName).collection('notificationRuns');
  users = client.db(databaseName).collection('users');
  sessions = client.db(databaseName).collection('sessions');
  const lasPinasUser = await users.findOne({ role: 'admin' }, { sort: { createdAt: 1 } });
  if (lasPinasUser) {
    const lasPinasBranchId = userBranchId(lasPinasUser);
    await clients.updateMany(
      { $or: [{ branchId: { $exists: false } }, { branchId: null }, { branchId: '' }] },
      { $set: { branchId: lasPinasBranchId, branchName: lasPinasUser.displayName || lasPinasUser.username, uploadedBy: lasPinasUser.username } }
    );
  }
  await clients.createIndex({ branchId: 1 });
  startNotificationScheduler();
  http.createServer(serve).listen(port, () => console.log(`ACOP Watch running at http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Unable to start ACOP Watch:', error.message);
  process.exitCode = 1;
});
