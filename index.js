import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { toNodeHandler } from 'better-auth/node';
import { jwt as betterAuthJwt, oneTap } from 'better-auth/plugins';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import cron from 'node-cron';

const app = express();
app.disable('etag');
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
  });
  next();
});

const port = Number(process.env.PORT || 5000);
const dbName = process.env.DB_NAME || 'rentgear';
const jwtSecret = process.env.JWT_SECRET;
const authBaseUrl = (process.env.BETTER_AUTH_URL || `http://localhost:${port}`).replace(/\/$/, '');
const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/.test(stripeKey) && !/^(?:sk|rk)_(?:test|live)_x+$/i.test(stripeKey)
  ? new Stripe(stripeKey)
  : null;
const clientOrigins = (process.env.CLIENT_URLS || 'http://localhost:3000')
  .split(',').map((value) => value.trim()).filter(Boolean);
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const betterAuthJwks = createRemoteJWKSet(new URL(`${authBaseUrl}/api/auth/jwks`));

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value with at least 32 characters.');
}
if (!betterAuthSecret || betterAuthSecret.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must be set to a random value with at least 32 characters.');
}

function mongoConnectionString() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const { DB_USER, DB_PASSWORD, DB_CLUSTER } = process.env;
  if (!DB_USER || !DB_PASSWORD || !DB_CLUSTER) {
    throw new Error('Set MONGODB_URI or DB_USER, DB_PASSWORD and DB_CLUSTER in the server environment.');
  }
  const cluster = DB_CLUSTER.replace(/^mongodb\+srv:\/\//, '').replace(/\/$/, '');
  return `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${cluster}/${dbName}?retryWrites=true&w=majority`;
}

const mongo = new MongoClient(mongoConnectionString(), { serverSelectionTimeoutMS: 10000 });
let users;
let equipment;
let bookings;
let payments;
let favorites;
let reviews;
let betterAuthHandler;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (status, message) => { throw new HttpError(status, message); };
const idOf = (id) => ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
const asId = (id) => String(id);
const publicUser = (user) => ({
  _id: asId(user._id || user.id), name: user.name, email: user.email, role: user.role,
  photoURL: user.photoURL || user.image || '', phone: user.phone || '', address: user.address || '',
  createdAt: user.createdAt, banned: !!user.banned, ...(user.provider ? { provider: user.provider } : {}),
});
const publicEquipment = (item) => ({ ...item, _id: asId(item._id), ownerId: asId(item.ownerId) });
const publicBooking = (item) => ({ ...item, _id: asId(item._id), equipmentId: asId(item.equipmentId), ownerId: asId(item.ownerId), customerId: asId(item.customerId) });
const pageArgs = (query) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 10)),
});
const paginated = async (collection, filter, query, sort = { createdAt: -1 }, map = (x) => x) => {
  const { page, limit } = pageArgs(query);
  const [items, total] = await Promise.all([
    collection.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
    collection.countDocuments(filter),
  ]);
  return { items: items.map(map), total, page, pages: Math.ceil(total / limit) };
};
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dateDays = (start, end) => Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
const rentalUnits = (type, days) => type === 'Weekly' ? Math.ceil(days / 7) : type === 'Monthly' ? Math.ceil(days / 30) : days;
const now = () => new Date();
const clientUrl = () => (process.env.NEXT_PUBLIC_SITE_URL || clientOrigins[0] || 'http://localhost:3000').replace(/\/$/, '');

// Optional email notifications — enabled when RESEND_API_KEY is configured.
const sendEmail = async (to, subject, html) => {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'RentGear <onboarding@resend.dev>',
        to, subject, html,
      }),
    });
  } catch (error) {
    console.error('Could not send notification email:', error.message);
  }
};
const notifyBookingCompleted = async (booking) => {
  const ids = [booking.customerId, booking.ownerId].map(idOf).filter(Boolean);
  if (!ids.length) return;
  const people = await users.find({ _id: { $in: ids } }).project({ name: 1, email: 1 }).toArray();
  await Promise.all(people.map((person) => sendEmail(
    person.email,
    `Your rental of ${booking.equipmentName} is complete`,
    `<p>Hi ${person.name},</p><p>The rental of <strong>${booking.equipmentName}</strong> (${booking.startDate} → ${booking.endDate}) is now marked as completed.</p><p>Total: ${booking.totalAmount} ${booking.currency || ''}</p><p>— RentGear</p>`,
  )));
};

const verifyToken = route(async (req, _res, next) => {
  const value = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!value) fail(401, 'Please sign in to continue.');
  let payload;
  try {
    ({ payload } = await jwtVerify(value, betterAuthJwks, {
      issuer: authBaseUrl,
      audience: authBaseUrl,
    }));
  } catch {
    try {
      payload = jwt.verify(value, jwtSecret, { issuer: 'rentgear-api', audience: 'rentgear-client' });
    } catch {
      fail(401, 'Your session has expired. Please sign in again.');
    }
  }
  const userId = idOf(payload.sub);
  const user = userId ? await users.findOne({ _id: userId }) : null;
  if (!user) fail(401, 'Your account could not be found. Please sign in again.');
  if (user.banned) fail(403, 'This account has been suspended by an administrator.');
  req.user = user;
  next();
});
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission to do that.'));
  next();
};
const verifyRenter = requireRole('customer');
const verifyOwner = requireRole('owner');
const verifyAdmin = requireRole('admin');
function validPassword(password) {
  return typeof password === 'string' && password.length >= 6 && /[a-z]/.test(password) && /[A-Z]/.test(password);
}
function validateEquipment(body) {
  const fields = ['name', 'description', 'category', 'location', 'condition', 'brand', 'model', 'image', 'rentalTerms'];
  for (const key of fields) if (typeof body[key] !== 'string' || !body[key].trim()) fail(400, `${key} is required.`);
  if (!/^https?:\/\//i.test(body.image)) fail(400, 'Equipment image must be a valid http(s) URL.');
  if (!['Daily', 'Weekly', 'Monthly'].includes(body.rentalType)) fail(400, 'Choose a valid rental type.');
  if (!Number.isFinite(Number(body.price)) || Number(body.price) <= 0) fail(400, 'Price must be greater than zero.');
  if (!Number.isInteger(Number(body.quantity)) || Number(body.quantity) < 0) fail(400, 'Quantity must be a non-negative whole number.');
}
function dateRange(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) fail(400, 'Choose a valid start and end date.');
  const startInstant = new Date(`${start}T00:00:00Z`); const endInstant = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startInstant.getTime()) || Number.isNaN(endInstant.getTime()) || startInstant.toISOString().slice(0, 10) !== start || endInstant.toISOString().slice(0, 10) !== end) fail(400, 'Choose valid calendar dates.');
  const days = dateDays(start, end);
  if (!Number.isInteger(days) || days < 1 || days > 366) fail(400, 'Rental dates must be within one year.');
  if (start < new Date().toISOString().slice(0, 10)) fail(400, 'Rental start date cannot be in the past.');
  return days;
}
async function getEquipment(id) {
  const objectId = idOf(id);
  if (!objectId) fail(400, 'Invalid equipment id.');
  const item = await equipment.findOne({ _id: objectId });
  if (!item) fail(404, 'Equipment was not found.');
  return item;
}
async function getBooking(id) {
  const objectId = idOf(id);
  if (!objectId) fail(400, 'Invalid booking id.');
  const item = await bookings.findOne({ _id: objectId });
  if (!item) fail(404, 'Booking was not found.');
  return item;
}
function canReadBooking(booking, user) {
  return user.role === 'admin' || String(booking.customerId) === String(user._id) || String(booking.ownerId) === String(user._id);
}
const activeBookingFilter = (startDate, endDate) => ({
  startDate: { $lte: endDate }, endDate: { $gte: startDate },
  status: { $in: ['pending', 'confirmed'] },
  $or: [
    { paymentStatus: 'paid' },
    { paymentStatus: 'unpaid', holdUntil: { $gt: now() } },
  ],
});
async function availableQuantity(item, startDate, endDate, session) {
  const reserved = await bookings.find({ equipmentId: item._id, ...activeBookingFilter(startDate, endDate) }, { session }).toArray();
  return Math.max(0, item.quantity - reserved.reduce((sum, row) => sum + row.quantity, 0));
}
async function updateBookingPaid(booking, session) {
  if (!booking || session.payment_status !== 'paid') return booking;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  const updated = await bookings.findOneAndUpdate(
    { _id: booking._id, paymentStatus: { $ne: 'paid' } },
    { $set: { paymentStatus: 'paid', status: 'confirmed', paidAt: now(), transactionId: paymentIntent || session.id, stripeSessionId: session.id } },
    { returnDocument: 'after' },
  );
  const paidBooking = updated || await bookings.findOne({ _id: booking._id });
  if (paidBooking?.paymentStatus === 'paid') {
    await payments.updateOne(
      { stripeSessionId: session.id },
      { $setOnInsert: { bookingId: paidBooking._id, customerId: paidBooking.customerId, ownerId: paidBooking.ownerId, amount: paidBooking.totalAmount, currency: session.currency || 'usd', status: 'paid', stripeSessionId: session.id, transactionId: paymentIntent || session.id, createdAt: paidBooking.paidAt || now() } },
      { upsert: true },
    );
  }
  return paidBooking;
}
async function createCheckout(booking) {
  if (!stripe) fail(503, 'Secure checkout is not configured yet.');
  if (booking.stripeSessionId) {
    const existing = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    if (existing.payment_status === 'paid') {
      await updateBookingPaid(booking, existing);
      fail(409, 'This booking has already been paid.');
    }
    if (existing.status === 'open' && existing.url && new Date(booking.holdUntil || 0) > now()) return existing;
  }
  const expiresAt = Math.floor((Date.now() + 35 * 60 * 1000) / 1000);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: booking.customerEmail,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd', unit_amount: Math.round(booking.totalAmount * 100),
        product_data: { name: booking.equipmentName, description: `${booking.startDate} to ${booking.endDate} · ${booking.quantity} unit(s)` },
      },
    }],
    metadata: { bookingId: asId(booking._id), customerId: asId(booking.customerId) },
    payment_intent_data: { metadata: { bookingId: asId(booking._id) } },
    expires_at: expiresAt,
    success_url: `${clientUrl()}/payment/success?booking_id=${booking._id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientUrl()}/payment/cancel?booking_id=${booking._id}`,
  });
  if (!session.url) fail(502, 'Stripe did not return a checkout link. Please try again.');
  await bookings.updateOne({ _id: booking._id }, { $set: { stripeSessionId: session.id, holdUntil: new Date(expiresAt * 1000) } });
  return session;
}

// Stripe requires the unparsed request body for signature verification.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), route(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) fail(503, 'Payment webhooks are not configured.');
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { fail(400, 'Invalid Stripe webhook signature.'); }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const bookingId = idOf(session.metadata?.bookingId);
    if (bookingId && session.payment_status === 'paid') {
      const booking = await bookings.findOne({ _id: bookingId });
      if (booking) await updateBookingPaid(booking, session);
    }
  }
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    await bookings.updateOne({ stripeSessionId: session.id, paymentStatus: 'unpaid', status: 'pending' }, { $set: { paymentStatus: 'expired', status: 'cancelled' } });
  }
  res.json({ received: true });
}));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin(origin, callback) {
  if (!origin || clientOrigins.includes(origin)) return callback(null, true);
  return callback(new HttpError(403, 'This site is not allowed to access the API.'));
}, credentials: true }));
app.all('/api/auth/*', (req, res, next) => {
  if (!betterAuthHandler) return next(new HttpError(503, 'Authentication is still starting.'));
  betterAuthHandler(req, res).catch(next);
});
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.json({ name: 'RentGear API', status: 'ok' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------- Profile ----------------
app.get('/api/users/me', verifyToken, route(async (req, res) => res.json({ user: publicUser(req.user) })));
app.patch('/api/users/me', verifyToken, route(async (req, res) => {
  const update = {};
  for (const key of ['name', 'photoURL', 'phone', 'address']) {
    if (typeof req.body[key] === 'string') update[key] = req.body[key].trim();
  }
  if (typeof req.body.email === 'string') {
    const email = req.body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
    if (email !== String(req.user.email || '').toLowerCase()) {
      if (await users.findOne({ email, _id: { $ne: req.user._id } })) fail(409, 'That email address is already registered.');
      update.email = email;
      // Keep Better Auth's credential lookup in sync (accountId is the email).
      await mongo.db(dbName).collection('account').updateMany(
        { userId: req.user._id, providerId: 'credential' },
        { $set: { accountId: email } },
      );
    }
  }
  if (update.name !== undefined && (update.name.length < 2 || update.name.length > 80)) fail(400, 'Name must be between 2 and 80 characters.');
  if (update.photoURL && !/^https?:\/\//i.test(update.photoURL)) fail(400, 'Photo URL must use http or https.');
  update.updatedAt = now();
  const fresh = await users.findOneAndUpdate({ _id: req.user._id }, { $set: update }, { returnDocument: 'after' });
  res.json({ user: publicUser(fresh) });
}));

// ---------------- Public and owner equipment ----------------
app.get('/api/equipment/featured', route(async (_req, res) => {
  const items = await equipment.find({ status: 'approved', quantity: { $gt: 0 } }).sort({ createdAt: -1 }).limit(6).toArray();
  res.json({ items: items.map(publicEquipment) });
}));
app.get('/api/equipment/categories', route(async (_req, res) => {
  const items = await equipment.aggregate([
    { $match: { status: 'approved', quantity: { $gt: 0 } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } }, { $limit: 24 },
  ]).toArray();
  res.json({ items: items.map((row) => ({ category: row._id, count: row.count })) });
}));
app.get('/api/equipment', route(async (req, res) => {
  const filter = { status: 'approved' };
  const term = String(req.query.search || '').trim();
  if (term) filter.$or = [{ name: { $regex: escapeRegex(term), $options: 'i' } }, { category: { $regex: escapeRegex(term), $options: 'i' } }];
  if (req.query.location) filter.location = { $regex: escapeRegex(req.query.location), $options: 'i' };
  if (req.query.category) filter.category = String(req.query.category);
  if (req.query.rentalType) {
    if (!['Daily', 'Weekly', 'Monthly'].includes(req.query.rentalType)) fail(400, 'Choose a valid rental type.');
    filter.rentalType = String(req.query.rentalType);
  }
  if (req.query.available === 'true') filter.quantity = { $gt: 0 };
  if (req.query.minPrice || req.query.maxPrice) filter.price = {};
  if (req.query.minPrice) {
    const minPrice = Number(req.query.minPrice);
    if (!Number.isFinite(minPrice) || minPrice < 0) fail(400, 'Minimum price must be a non-negative number.');
    filter.price.$gte = minPrice;
  }
  if (req.query.maxPrice) {
    const maxPrice = Number(req.query.maxPrice);
    if (!Number.isFinite(maxPrice) || maxPrice < 0) fail(400, 'Maximum price must be a non-negative number.');
    filter.price.$lte = maxPrice;
  }
  if (filter.price?.$gte !== undefined && filter.price?.$lte !== undefined && filter.price.$gte > filter.price.$lte) fail(400, 'Minimum price cannot exceed maximum price.');
  const sort = req.query.sort === 'price_asc' ? { price: 1 } : req.query.sort === 'price_desc' ? { price: -1 } : { createdAt: -1 };
  res.json(await paginated(equipment, filter, req.query, sort, publicEquipment));
}));
app.get('/api/equipment/:id/availability', route(async (req, res) => {
  const item = await getEquipment(req.params.id);
  if (item.status !== 'approved') fail(404, 'Equipment is not available.');
  const startDate = String(req.query.startDate || ''); const endDate = String(req.query.endDate || '');
  const days = dateRange(startDate, endDate);
  const quantity = Math.max(1, Math.floor(Number(req.query.quantity) || 1));
  const available = await availableQuantity(item, startDate, endDate);
  const units = rentalUnits(item.rentalType, days);
  res.json({ available, days, estimate: { units, total: item.price * units * quantity } });
}));
app.get('/api/equipment/:id/reviews', route(async (req, res) => {
  const itemId = idOf(req.params.id); if (!itemId) fail(400, 'Invalid equipment id.');
  const rows = await reviews.find({ equipmentId: itemId }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json({ items: rows.map((row) => ({ ...row, _id: asId(row._id), equipmentId: asId(row.equipmentId), userId: asId(row.userId), bookingId: asId(row.bookingId) })) });
}));
app.get('/api/equipment/:id', route(async (req, res) => {
  const item = await getEquipment(req.params.id);
  if (item.status !== 'approved') {
    const auth = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    let caller = null;
    try { const payload = jwt.verify(auth || '', jwtSecret); caller = await users.findOne({ _id: idOf(payload.sub) }); } catch { /* public caller */ }
    if (!caller || (caller.role !== 'admin' && String(caller._id) !== String(item.ownerId))) fail(404, 'Equipment was not found.');
  }
  res.json({ item: publicEquipment(item) });
}));

app.post('/api/equipment', verifyToken, verifyOwner, route(async (req, res) => {
  validateEquipment(req.body);
  const item = {
    ...Object.fromEntries(['name', 'description', 'category', 'location', 'condition', 'brand', 'model', 'image', 'rentalTerms'].map((k) => [k, req.body[k].trim()])),
    price: Number(req.body.price), rentalType: req.body.rentalType, quantity: Number(req.body.quantity),
    status: 'pending', ownerId: req.user._id, ownerName: req.user.name, ownerEmail: req.user.email, ownerPhoto: req.user.photoURL || '',
    createdAt: now(), updatedAt: now(),
  };
  const result = await equipment.insertOne(item); item._id = result.insertedId;
  res.status(201).json({ item: publicEquipment(item) });
}));
app.get('/api/owner/equipment', verifyToken, verifyOwner, route(async (req, res) => {
  res.json(await paginated(equipment, { ownerId: req.user._id }, req.query, { createdAt: -1 }, publicEquipment));
}));
app.put('/api/equipment/:id', verifyToken, verifyOwner, route(async (req, res) => {
  validateEquipment(req.body);
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid equipment id.');
  const update = { ...Object.fromEntries(['name', 'description', 'category', 'location', 'condition', 'brand', 'model', 'image', 'rentalTerms'].map((k) => [k, req.body[k].trim()])), price: Number(req.body.price), rentalType: req.body.rentalType, quantity: Number(req.body.quantity), status: 'pending', updatedAt: now() };
  const item = await equipment.findOneAndUpdate({ _id: objectId, ownerId: req.user._id }, { $set: update }, { returnDocument: 'after' });
  if (!item) fail(404, 'Equipment was not found in your listings.');
  res.json({ item: publicEquipment(item) });
}));
app.delete('/api/equipment/:id', verifyToken, verifyOwner, route(async (req, res) => {
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid equipment id.');
  const pending = await bookings.findOne({ equipmentId: objectId, status: { $in: ['pending', 'confirmed'] } });
  if (pending) fail(409, 'This equipment has an active booking and cannot be deleted.');
  const result = await equipment.deleteOne({ _id: objectId, ownerId: req.user._id });
  if (!result.deletedCount) fail(404, 'Equipment was not found in your listings.');
  res.json({ success: true });
}));

// ---------------- Favorites ----------------
app.get('/api/favorites/ids', verifyToken, verifyRenter, route(async (req, res) => {
  const rows = await favorites.find({ userId: req.user._id }).project({ equipmentId: 1 }).toArray();
  res.json({ ids: rows.map((row) => asId(row.equipmentId)) });
}));
app.get('/api/favorites', verifyToken, verifyRenter, route(async (req, res) => {
  const rows = await favorites.find({ userId: req.user._id }).sort({ createdAt: -1 }).toArray();
  const ids = rows.map((row) => row.equipmentId);
  const items = ids.length ? await equipment.find({ _id: { $in: ids } }).toArray() : [];
  const order = new Map(ids.map((id, index) => [String(id), index]));
  items.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
  res.json({ items: items.map(publicEquipment) });
}));
app.post('/api/favorites/:id', verifyToken, verifyRenter, route(async (req, res) => {
  const item = await getEquipment(req.params.id); if (item.status !== 'approved') fail(404, 'Equipment was not found.');
  await favorites.updateOne({ userId: req.user._id, equipmentId: item._id }, { $setOnInsert: { userId: req.user._id, equipmentId: item._id, createdAt: now() } }, { upsert: true });
  res.status(201).json({ success: true });
}));
app.delete('/api/favorites/:id', verifyToken, verifyRenter, route(async (req, res) => {
  const itemId = idOf(req.params.id); if (!itemId) fail(400, 'Invalid equipment id.');
  await favorites.deleteOne({ userId: req.user._id, equipmentId: itemId }); res.json({ success: true });
}));

// ---------------- Bookings and Stripe checkout ----------------
app.get('/api/bookings/my', verifyToken, verifyRenter, route(async (req, res) => {
  res.json(await paginated(bookings, { customerId: req.user._id }, req.query, { createdAt: -1 }, publicBooking));
}));
app.get('/api/bookings/owner', verifyToken, verifyOwner, route(async (req, res) => {
  res.json(await paginated(bookings, { ownerId: req.user._id }, req.query, { createdAt: -1 }, publicBooking));
}));
app.get('/api/admin/bookings', verifyToken, verifyAdmin, route(async (req, res) => {
  const result = await paginated(bookings, {}, req.query, { createdAt: -1 }, publicBooking);
  // Older bookings only stored ownerId — fill owner details so the admin table
  // can show full owner information without a second round trip.
  const missing = result.items.some((b) => !b.ownerName);
  if (missing) {
    const ids = [...new Set(result.items.map((b) => idOf(b.ownerId)).filter(Boolean))];
    const owners = ids.length
      ? await users.find({ _id: { $in: ids } }).project({ name: 1, email: 1 }).toArray()
      : [];
    const byId = new Map(owners.map((o) => [String(o._id), o]));
    for (const b of result.items) {
      if (b.ownerName) continue;
      const owner = byId.get(String(b.ownerId));
      if (owner) { b.ownerName = owner.name; b.ownerEmail = owner.email; }
    }
  }
  res.json(result);
}));
app.patch('/api/admin/bookings/:id/status', verifyToken, verifyAdmin, route(async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (req.body.status === 'cancelled') {
    if (booking.status !== 'pending' || booking.paymentStatus !== 'unpaid') {
      fail(409, 'Only unpaid pending bookings can be cancelled.');
    }
    if (booking.stripeSessionId) {
      if (!stripe) fail(503, 'Stripe is required to safely cancel this booking.');
      const checkout = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
      if (checkout.payment_status === 'paid') {
        await updateBookingPaid(booking, checkout);
        fail(409, 'This booking has already been paid and cannot be cancelled.');
      }
      if (checkout.status === 'open') await stripe.checkout.sessions.expire(booking.stripeSessionId);
    }
    const updated = await bookings.findOneAndUpdate(
      { _id: booking._id, status: 'pending', paymentStatus: 'unpaid' },
      { $set: { status: 'cancelled' } },
      { returnDocument: 'after' },
    );
    if (!updated) fail(409, 'This booking has already changed and cannot be cancelled.');
    res.json({ item: publicBooking(updated) });
    return;
  }
  if (req.body.status === 'completed') {
    if (booking.status !== 'confirmed' || booking.paymentStatus !== 'paid') {
      fail(409, 'Only paid, confirmed rentals can be completed.');
    }
    const updated = await bookings.findOneAndUpdate(
      { _id: booking._id, status: 'confirmed', paymentStatus: 'paid' },
      { $set: { status: 'completed', completedAt: now() } },
      { returnDocument: 'after' },
    );
    if (!updated) fail(409, 'This booking has already changed and cannot be completed.');
    void notifyBookingCompleted(updated);
    res.json({ item: publicBooking(updated) });
    return;
  }
  fail(400, 'Admins can only cancel unpaid pending bookings or complete paid rentals.');
}));
app.get('/api/bookings/:id', verifyToken, route(async (req, res) => {
  const booking = await getBooking(req.params.id); if (!canReadBooking(booking, req.user)) fail(404, 'Booking was not found.');
  res.json({ item: publicBooking(booking) });
}));
app.post('/api/bookings', verifyToken, verifyRenter, route(async (req, res) => {
  const item = await getEquipment(req.body.equipmentId); if (item.status !== 'approved') fail(404, 'Equipment is not available for booking.');
  const startDate = String(req.body.startDate || ''); const endDate = String(req.body.endDate || '');
  const days = dateRange(startDate, endDate);
  const quantity = Math.floor(Number(req.body.quantity));
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) fail(400, 'Choose a valid rental quantity.');
  const available = await availableQuantity(item, startDate, endDate);
  if (quantity > available) fail(409, `Only ${available} unit(s) are available for those dates.`);
  const phone = String(req.body.phone || '').trim(); const address = String(req.body.address || '').trim();
  if (!phone || !address) fail(400, 'Phone number and delivery address are required.');
  const units = rentalUnits(item.rentalType, days);
  const booking = {
    equipmentId: item._id, equipmentName: item.name, equipmentImage: item.image, ownerId: item.ownerId,
    ownerName: item.ownerName || '', ownerEmail: item.ownerEmail || '',
    customerId: req.user._id, customerName: req.user.name, customerEmail: req.user.email,
    startDate, endDate, days, rentalType: item.rentalType, rentalUnits: units, pricePerUnit: item.price,
    quantity, totalAmount: Math.round(item.price * units * quantity * 100) / 100,
    phone, address, notes: String(req.body.notes || '').trim().slice(0, 500),
    status: 'pending', paymentStatus: 'unpaid', createdAt: now(),
  };
  const mongoSession = mongo.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      // Serialize reservations for one listing so concurrent checkouts cannot overbook it.
      await equipment.updateOne({ _id: item._id }, { $inc: { reservationVersion: 1 } }, { session: mongoSession });
      const availableNow = await availableQuantity(item, startDate, endDate, mongoSession);
      if (quantity > availableNow) fail(409, `Only ${availableNow} unit(s) are available for those dates.`);
      const inserted = await bookings.insertOne(booking, { session: mongoSession });
      booking._id = inserted.insertedId;
    });
    const checkout = await createCheckout(booking);
    res.status(201).json({ bookingId: asId(booking._id), checkoutUrl: checkout.url });
  } catch (error) {
    if (booking._id) await bookings.deleteOne({ _id: booking._id, paymentStatus: 'unpaid' });
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}));
app.post('/api/bookings/:id/pay', verifyToken, verifyRenter, route(async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (String(booking.customerId) !== String(req.user._id)) fail(404, 'Booking was not found.');
  if (booking.paymentStatus === 'paid') fail(409, 'This booking has already been paid.');
  if (booking.status !== 'pending' || new Date(booking.holdUntil || 0) <= now()) fail(409, 'This booking hold has expired. Create a new booking to continue.');
  const session = await createCheckout(booking);
  res.json({ checkoutUrl: session.url });
}));
app.patch('/api/bookings/:id/cancel', verifyToken, verifyRenter, route(async (req, res) => {
  const booking = await getBooking(req.params.id);
  if (String(booking.customerId) !== String(req.user._id)) fail(404, 'Booking was not found.');
  if (booking.paymentStatus === 'paid' || booking.status !== 'pending') fail(409, 'This booking can no longer be cancelled online.');
  if (stripe && booking.stripeSessionId) {
    const checkout = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    if (checkout.payment_status === 'paid') {
      await updateBookingPaid(booking, checkout);
      fail(409, 'This booking has already been paid and cannot be cancelled.');
    }
    if (checkout.status === 'open') await stripe.checkout.sessions.expire(booking.stripeSessionId);
  }
  const updated = await bookings.findOneAndUpdate({ _id: booking._id, paymentStatus: 'unpaid', status: 'pending' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' });
  if (!updated) fail(409, 'This booking has already changed and cannot be cancelled.');
  res.json({ item: publicBooking(updated) });
}));
app.post('/api/bookings/:id/verify', verifyToken, verifyRenter, route(async (req, res) => {
  if (!stripe) fail(503, 'Payment verification is not configured.');
  let booking = await getBooking(req.params.id);
  if (String(booking.customerId) !== String(req.user._id)) fail(404, 'Booking was not found.');
  if (booking.stripeSessionId && booking.paymentStatus !== 'paid') {
    const session = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    if (session.payment_status === 'paid') booking = await updateBookingPaid(booking, session);
  }
  res.json({ item: publicBooking(booking) });
}));
app.patch('/api/bookings/:id/status', verifyToken, verifyOwner, route(async (req, res) => {
  if (req.body.status !== 'completed') fail(400, 'Owners can only mark a rental completed.');
  const booking = await getBooking(req.params.id);
  if (String(booking.ownerId) !== String(req.user._id)) fail(404, 'Booking was not found.');
  if (booking.paymentStatus !== 'paid' || booking.status !== 'confirmed') fail(409, 'Only paid, confirmed rentals can be completed.');
  const updated = await bookings.findOneAndUpdate({ _id: booking._id, status: 'confirmed' }, { $set: { status: 'completed', completedAt: now() } }, { returnDocument: 'after' });
  void notifyBookingCompleted(updated);
  res.json({ item: publicBooking(updated) });
}));

// ---------------- Admin review and user management ----------------
app.get('/api/admin/users', verifyToken, verifyAdmin, route(async (req, res) => {
  const filter = {};
  if (['customer', 'owner', 'admin'].includes(req.query.role)) filter.role = req.query.role;
  if (req.query.search) {
    const regex = { $regex: escapeRegex(req.query.search), $options: 'i' };
    filter.$or = [{ name: regex }, { email: regex }];
  }
  res.json(await paginated(users, filter, req.query, { createdAt: -1 }, publicUser));
}));
app.patch('/api/admin/users/:id/role', verifyToken, verifyAdmin, route(async (req, res) => {
  if (!['customer', 'owner', 'admin'].includes(req.body.role)) fail(400, 'Choose a valid role.');
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid user id.');
  if (String(objectId) === String(req.user._id)) fail(400, 'You cannot change your own role.');
  const user = await users.findOneAndUpdate({ _id: objectId }, { $set: { role: req.body.role, updatedAt: now() } }, { returnDocument: 'after' });
  if (!user) fail(404, 'User was not found.');
  res.json({ user: publicUser(user) });
}));
app.patch('/api/admin/users/:id/ban', verifyToken, verifyAdmin, route(async (req, res) => {
  if (typeof req.body.banned !== 'boolean') fail(400, 'Choose a valid account state.');
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid user id.');
  if (String(objectId) === String(req.user._id)) fail(400, 'You cannot suspend your own account.');
  const user = await users.findOne({ _id: objectId }); if (!user) fail(404, 'User was not found.');
  if (user.role === 'admin' && req.body.banned) fail(400, 'Admin accounts cannot be suspended.');
  const updated = await users.findOneAndUpdate(
    { _id: objectId },
    { $set: { banned: req.body.banned, updatedAt: now() } },
    { returnDocument: 'after' },
  );
  res.json({ user: publicUser(updated) });
}));
app.get('/api/admin/equipment', verifyToken, verifyAdmin, route(async (req, res) => {
  const filter = {};
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) filter.status = req.query.status;
  res.json(await paginated(equipment, filter, req.query, { createdAt: -1 }, publicEquipment));
}));
app.patch('/api/admin/equipment/:id/status', verifyToken, verifyAdmin, route(async (req, res) => {
  if (!['pending', 'approved', 'rejected'].includes(req.body.status)) fail(400, 'Choose a valid equipment status.');
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid equipment id.');
  const item = await equipment.findOneAndUpdate({ _id: objectId }, { $set: { status: req.body.status, updatedAt: now() } }, { returnDocument: 'after' });
  if (!item) fail(404, 'Equipment was not found.');
  res.json({ item: publicEquipment(item) });
}));
app.put('/api/admin/equipment/:id', verifyToken, verifyAdmin, route(async (req, res) => {
  validateEquipment(req.body);
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid equipment id.');
  const data = { ...Object.fromEntries(['name', 'description', 'category', 'location', 'condition', 'brand', 'model', 'image', 'rentalTerms'].map((k) => [k, req.body[k].trim()])), price: Number(req.body.price), quantity: Number(req.body.quantity), rentalType: req.body.rentalType, updatedAt: now() };
  const item = await equipment.findOneAndUpdate({ _id: objectId }, { $set: data }, { returnDocument: 'after' });
  if (!item) fail(404, 'Equipment was not found.');
  res.json({ item: publicEquipment(item) });
}));
app.delete('/api/admin/equipment/:id', verifyToken, verifyAdmin, route(async (req, res) => {
  const objectId = idOf(req.params.id); if (!objectId) fail(400, 'Invalid equipment id.');
  const result = await equipment.deleteOne({ _id: objectId }); if (!result.deletedCount) fail(404, 'Equipment was not found.');
  res.json({ success: true });
}));

// ---------------- Reviews ----------------
app.post('/api/reviews', verifyToken, verifyRenter, route(async (req, res) => {
  const bookingId = idOf(req.body.bookingId); if (!bookingId) fail(400, 'Invalid booking id.');
  const booking = await bookings.findOne({ _id: bookingId, customerId: req.user._id, status: 'completed', paymentStatus: 'paid' });
  if (!booking) fail(403, 'A completed, paid rental is required before reviewing equipment.');
  const rating = Number(req.body.rating); const comment = String(req.body.comment || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Rating must be between 1 and 5.');
  if (!comment || comment.length > 1000) fail(400, 'Review must be between 1 and 1000 characters.');
  if (await reviews.findOne({ bookingId })) fail(409, 'You have already reviewed this rental.');
  const review = { bookingId, equipmentId: booking.equipmentId, equipmentName: booking.equipmentName, userId: req.user._id, userName: req.user.name, userPhoto: req.user.photoURL || '', rating, comment, createdAt: now() };
  const result = await reviews.insertOne(review); review._id = result.insertedId;
  res.status(201).json({ item: { ...review, _id: asId(review._id), bookingId: asId(bookingId), equipmentId: asId(booking.equipmentId), userId: asId(req.user._id) } });
}));
app.get('/api/reviews', route(async (req, res) => {
  const limit = Math.min(12, Math.max(1, Number(req.query.limit) || 6));
  const items = await reviews.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  res.json({ items: items.map((row) => ({ ...row, _id: asId(row._id), bookingId: asId(row.bookingId), equipmentId: asId(row.equipmentId), userId: asId(row.userId) })) });
}));

// ---------------- Role-specific analytics ----------------
app.get('/api/stats/customer', verifyToken, verifyRenter, route(async (req, res) => {
  const mine = await bookings.find({ customerId: req.user._id }).toArray();
  const favCount = await favorites.countDocuments({ userId: req.user._id });
  res.json({ totalRentals: mine.length, activeRentals: mine.filter((b) => b.status === 'confirmed').length, completedRentals: mine.filter((b) => b.status === 'completed').length, favorites: favCount, totalSpent: mine.filter((b) => b.paymentStatus === 'paid').reduce((sum, b) => sum + b.totalAmount, 0) });
}));
app.get('/api/stats/owner', verifyToken, verifyOwner, route(async (req, res) => {
  const [totalListed, completed, mine] = await Promise.all([
    equipment.countDocuments({ ownerId: req.user._id }),
    bookings.countDocuments({ ownerId: req.user._id, status: 'completed' }),
    payments.find({ ownerId: req.user._id, status: 'paid' }).toArray(),
  ]);
  const monthly = new Map();
  for (let offset = 11; offset >= 0; offset--) {
    const date = new Date(); date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); date.setUTCMonth(date.getUTCMonth() - offset);
    monthly.set(date.toISOString().slice(0, 7), 0);
  }
  for (const payment of mine) { const key = new Date(payment.createdAt).toISOString().slice(0, 7); if (monthly.has(key)) monthly.set(key, monthly.get(key) + payment.amount); }
  res.json({ totalListed, completedRentals: completed, totalEarnings: mine.reduce((sum, p) => sum + p.amount, 0), monthlyEarnings: [...monthly].map(([month, earnings]) => ({ month, earnings })) });
}));
app.get('/api/stats/admin', verifyToken, verifyAdmin, route(async (_req, res) => {
  const [totalUsers, totalEquipment, totalBookings, pendingApprovals, paidPayments, allBookings, roleCounts] = await Promise.all([
    users.countDocuments({}), equipment.countDocuments({}), bookings.countDocuments({}), equipment.countDocuments({ status: 'pending' }),
    payments.find({ status: 'paid' }).toArray(), bookings.find({}).project({ createdAt: 1, status: 1 }).toArray(),
    users.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray(),
  ]);
  const monthly = new Map();
  for (let offset = 11; offset >= 0; offset--) { const date = new Date(); date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); date.setUTCMonth(date.getUTCMonth() - offset); monthly.set(date.toISOString().slice(0, 7), 0); }
  for (const booking of allBookings) { const key = new Date(booking.createdAt).toISOString().slice(0, 7); if (monthly.has(key)) monthly.set(key, monthly.get(key) + 1); }
  const roleMap = new Map(roleCounts.map((row) => [row._id, row.count]));
  res.json({ totalUsers, totalEquipment, totalBookings, pendingApprovals, completedRentals: allBookings.filter((b) => b.status === 'completed').length, totalRevenue: paidPayments.reduce((sum, payment) => sum + payment.amount, 0), monthlyBookings: [...monthly].map(([month, count]) => ({ month, bookings: count })), usersByRole: ['customer', 'owner', 'admin'].map((role) => ({ role, count: roleMap.get(role) || 0 })) });
}));

app.use((_req, _res, next) => next(new HttpError(404, 'The requested API route was not found.')));
app.use((error, _req, res, _next) => {
  if (error.code === 11000) return res.status(409).json({ message: 'This record already exists.' });
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('API error:', error.message);
  res.status(status).json({ message: status >= 500 ? 'The server could not complete the request.' : error.message });
});

function createAuth(db) {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return betterAuth({
    appName: 'RentGear',
    baseURL: authBaseUrl,
    basePath: '/api/auth',
    secret: betterAuthSecret,
    trustedOrigins: clientOrigins,
    database: mongodbAdapter(db, { client: mongo }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
      maxPasswordLength: 128,
      requireEmailVerification: false,
      password: {
        hash: async (password) => {
          if (!validPassword(password)) {
            throw new APIError('BAD_REQUEST', {
              message: 'Password must include uppercase and lowercase letters and be at least 6 characters.',
            });
          }
          return bcrypt.hash(password, 12);
        },
        verify: ({ hash, password }) => bcrypt.compare(password, hash),
      },
    },
    ...(googleClientId && googleClientSecret ? {
      socialProviders: {
        google: { clientId: googleClientId, clientSecret: googleClientSecret },
      },
    } : {}),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
        requireLocalEmailVerified: false,
      },
    },
    user: {
      modelName: 'users',
      fields: { image: 'photoURL' },
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'customer', input: true },
        phone: { type: 'string', required: false, defaultValue: '', input: false },
        address: { type: 'string', required: false, defaultValue: '', input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const email = String(user.email || '').trim().toLowerCase();
            const signupRole = context?.getHeader('x-signup-role');
            const isGoogleSignup = context?.path?.endsWith('/one-tap/callback');
            if (isGoogleSignup && signupRole !== 'customer' && signupRole !== 'owner') {
              throw new APIError('BAD_REQUEST', {
                message: 'Choose a customer or equipment owner role on the sign-up page before using Google sign-up.',
              });
            }
            const requestedRole = user.role === 'owner' || signupRole === 'owner' ? 'owner' : 'customer';
            return {
              data: {
                ...user,
                email,
                role: adminEmails.has(email) ? 'admin' : requestedRole,
                phone: typeof user.phone === 'string' ? user.phone : '',
                address: typeof user.address === 'string' ? user.address : '',
              },
            };
          },
        },
        update: {
          before: async (user) => {
            const { role: _role, ...safeUser } = user;
            return { data: safeUser };
          },
        },
      },
    },
    plugins: [
      betterAuthJwt(),
      ...(googleClientId ? [oneTap({ clientId: googleClientId })] : []),
    ],
  });
}

async function migrateLegacyPasswordAccounts(accountCollection) {
  await accountCollection.createIndex({ userId: 1, providerId: 1 });
  await users.updateMany(
    { provider: 'google', emailVerified: { $ne: true } },
    { $set: { emailVerified: true } },
  );
  const legacyUsers = users.find({ passwordHash: { $type: 'string' } });
  for await (const user of legacyUsers) {
    await accountCollection.updateOne(
      { userId: user._id, providerId: 'credential' },
      {
        $setOnInsert: {
          accountId: asId(user._id),
          providerId: 'credential',
          userId: user._id,
          password: user.passwordHash,
          createdAt: user.createdAt || now(),
          updatedAt: user.updatedAt || now(),
        },
      },
      { upsert: true },
    );
  }
}

async function start() {
  await mongo.connect();
  const db = mongo.db(dbName);
  users = db.collection('users'); equipment = db.collection('equipment'); bookings = db.collection('bookings');
  payments = db.collection('payments'); favorites = db.collection('favorites'); reviews = db.collection('reviews');
  const auth = createAuth(db);
  betterAuthHandler = toNodeHandler(auth);
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    equipment.createIndex({ status: 1, createdAt: -1 }), equipment.createIndex({ ownerId: 1, createdAt: -1 }),
    bookings.createIndex({ customerId: 1, createdAt: -1 }), bookings.createIndex({ ownerId: 1, createdAt: -1 }),
    bookings.createIndex({ equipmentId: 1, startDate: 1, endDate: 1, status: 1 }), bookings.createIndex({ stripeSessionId: 1 }, { sparse: true }),
    payments.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }), payments.createIndex({ ownerId: 1, status: 1, createdAt: -1 }), favorites.createIndex({ userId: 1, equipmentId: 1 }, { unique: true }),
    reviews.createIndex({ bookingId: 1 }, { unique: true, sparse: true }), reviews.createIndex({ equipmentId: 1, createdAt: -1 }),
  ]);
  await migrateLegacyPasswordAccounts(db.collection('account'));
  const refreshRentalStatuses = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const justCompleted = await bookings
        .find({ status: 'confirmed', paymentStatus: 'paid', endDate: { $lt: today } })
        .toArray();
      await Promise.all([
        bookings.updateMany(
          { status: 'pending', paymentStatus: 'unpaid', holdUntil: { $lte: now() } },
          { $set: { status: 'cancelled', paymentStatus: 'expired' } },
        ),
        bookings.updateMany(
          { status: 'confirmed', paymentStatus: 'paid', endDate: { $lt: today } },
          { $set: { status: 'completed', completedAt: now() } },
        ),
      ]);
      for (const booking of justCompleted) void notifyBookingCompleted(booking);
    } catch (error) {
      console.error('Could not refresh expired rental statuses:', error.message);
    }
  };
  // node-cron job: expires unpaid holds and completes rentals whose end date has passed.
  cron.schedule('*/1 * * * *', refreshRentalStatuses);
  await refreshRentalStatuses();
  app.listen(port, () => {
    console.log(`Server is running on port number ${port}`);
    console.log('MongoDB connection successful');
  });
}

start().catch((error) => { console.error('Could not start RentGear API:', error.message); process.exit(1); });

process.on('SIGINT', async () => { await mongo.close(); process.exit(0); });
process.on('SIGTERM', async () => { await mongo.close(); process.exit(0); });
