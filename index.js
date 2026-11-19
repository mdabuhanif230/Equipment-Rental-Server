// =====================================================================
// Equipment Rental Platform - Backend (single file)
// Express + MongoDB (native driver) + JWT + Stripe + ImgBB
// =====================================================================
import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";

// ---------------------------------------------------------------------
// 1. ENV + CONSTANTS
// ---------------------------------------------------------------------
// Only these 4 come from .env (PORT, DB_USER, DB_PASSWORD, STRIPE_SECRET_KEY)
const { PORT = 5000, DB_USER, DB_PASSWORD, STRIPE_SECRET_KEY } = process.env;

// ---- EDIT THESE VALUES (they are not secrets) ----
const DB_CLUSTER = "cluster0.xxxxx.mongodb.net"; // from Atlas > Connect > Drivers
const DB_NAME = "equipment_rental";
const CLIENT_URLS = ["http://localhost:3000"]; // add your Vercel URL here after deploy
const GOOGLE_CLIENT_ID = ""; // public Google OAuth client id (only for Google login)
// ---------------------------------------------------

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // optional (see README)
// JWT secret is derived from your private env values, so no extra variable is needed
const JWT_SECRET = crypto.createHash("sha256").update(`jwt|${DB_PASSWORD}|${STRIPE_SECRET_KEY}`).digest("hex");

for (const [key, value] of Object.entries({ DB_USER, DB_PASSWORD, STRIPE_SECRET_KEY })) {
  if (!value) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}
if (DB_CLUSTER.includes("xxxxx")) {
  console.error("Please set DB_CLUSTER at the top of index.js (example: cluster0.abcde.mongodb.net)");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOLD_MS = 35 * 60 * 1000; // a pending booking holds stock for 35 minutes
const MAX_RENTAL_DAYS = 365;
const RENTAL_TYPES = ["Daily", "Weekly", "Monthly"];
const ROLES = ["customer", "owner", "admin"];
const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"];

// ---------------------------------------------------------------------
// 2. DATABASE
// ---------------------------------------------------------------------
const uri = `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_CLUSTER}/?retryWrites=true&w=majority&appName=EquipmentRental`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});
const col = {}; // collections are filled after connecting

async function connectDB() {
  await client.connect();
  const db = client.db(DB_NAME);
  col.users = db.collection("users");
  col.equipment = db.collection("equipment");
  col.bookings = db.collection("bookings");
  col.favorites = db.collection("favorites");
  col.payments = db.collection("payments");
  col.reviews = db.collection("reviews");

  await Promise.all([
    col.users.createIndex({ email: 1 }, { unique: true }),
    col.equipment.createIndex({ status: 1, category: 1, createdAt: -1 }),
    col.equipment.createIndex({ ownerId: 1 }),
    col.bookings.createIndex({ equipmentId: 1, startDate: 1, endDate: 1 }),
    col.bookings.createIndex({ customerId: 1 }),
    col.bookings.createIndex({ ownerId: 1 }),
    col.favorites.createIndex({ userId: 1, equipmentId: 1 }, { unique: true }),
    col.payments.createIndex({ sessionId: 1 }, { unique: true }),
    col.reviews.createIndex({ bookingId: 1 }, { unique: true }),
    col.reviews.createIndex({ equipmentId: 1, createdAt: -1 }),
  ]);
  console.log("MongoDB connected");
}

// ---------------------------------------------------------------------
// 3. HELPERS
// ---------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const oid = (id) => {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) throw new HttpError(400, "Invalid id");
  return new ObjectId(id);
};
const str = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const money = (n) => Math.round(n * 100) / 100;

const parseDate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const todayUTC = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

const paginate = (req, defaultLimit = 10) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || defaultLimit, 1), 50);
  return { page, limit, skip: (page - 1) * limit };
};
const pageResult = (items, total, page, limit) => ({ items, total, page, pages: Math.ceil(total / limit) || 1 });

const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  photoURL: u.photoURL || "",
  phone: u.phone || "",
  createdAt: u.createdAt,
});
const signToken = (user) => jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });

const validatePassword = (p) => {
  if (typeof p !== "string" || p.length < 6) return "Password must be at least 6 characters";
  if (!/[A-Z]/.test(p)) return "Password must contain an uppercase letter";
  if (!/[a-z]/.test(p)) return "Password must contain a lowercase letter";
  return null;
};
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---------------------------------------------------------------------
// 4. MIDDLEWARES
// ---------------------------------------------------------------------
async function loadUserFromToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    const { id } = jwt.verify(header.slice(7), JWT_SECRET);
    return await col.users.findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

const verifyToken = wrap(async (req, res, next) => {
  const user = await loadUserFromToken(req);
  if (!user) throw new HttpError(401, "Unauthorized: please login again");
  req.user = user; // role always comes from the database, never from the client
  next();
});
const optionalAuth = wrap(async (req, res, next) => {
  req.user = await loadUserFromToken(req);
  next();
});
const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : next(new HttpError(403, `Forbidden: ${role} access only`));

const verifyRenter = [verifyToken, requireRole("customer")];
const verifyOwner = [verifyToken, requireRole("owner")];
const verifyAdmin = [verifyToken, requireRole("admin")];

// ---------------------------------------------------------------------
// 5. BUSINESS HELPERS (equipment validation, availability, pricing)
// ---------------------------------------------------------------------
function validateEquipment(b) {
  const data = {
    name: str(b.name, 120),
    description: str(b.description, 3000),
    category: str(b.category, 60),
    location: str(b.location, 120),
    price: Number(b.price),
    rentalType: str(b.rentalType, 10),
    quantity: Number(b.quantity),
    condition: str(b.condition, 40),
    brand: str(b.brand, 60),
    model: str(b.model, 60),
    image: str(b.image, 500),
    rentalTerms: str(b.rentalTerms, 2000),
  };
  for (const f of ["name", "description", "category", "location", "condition", "brand", "model", "image", "rentalTerms"]) {
    if (!data[f]) throw new HttpError(400, `${f} is required`);
  }
  if (!Number.isFinite(data.price) || data.price <= 0) throw new HttpError(400, "Price must be greater than 0");
  if (!RENTAL_TYPES.includes(data.rentalType)) throw new HttpError(400, "Rental type must be Daily, Weekly or Monthly");
  if (!Number.isInteger(data.quantity) || data.quantity < 0) throw new HttpError(400, "Quantity must be a whole number (0 or more)");
  if (!/^https?:\/\//.test(data.image)) throw new HttpError(400, "Image must be a valid URL");
  data.price = money(data.price);
  return data;
}

// How many units are free for the whole date range?
async function getAvailableQuantity(equipment, start, end, excludeBookingId = null) {
  const query = {
    equipmentId: equipment._id,
    startDate: { $lte: end },
    endDate: { $gte: start },
    $or: [{ status: "confirmed" }, { status: "pending", holdUntil: { $gt: new Date() } }],
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };
  const overlapping = await col.bookings.find(query).toArray();

  let peak = 0; // highest number of units used on any single day
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    let used = 0;
    for (const b of overlapping) {
      if (b.startDate.getTime() <= t && b.endDate.getTime() >= t) used += b.quantity;
    }
    peak = Math.max(peak, used);
  }
  return equipment.quantity - peak;
}

function validateDates(startStr, endStr) {
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  if (!start || !end) throw new HttpError(400, "Dates must be in YYYY-MM-DD format");
  if (start < todayUTC()) throw new HttpError(400, "Start date cannot be in the past");
  if (end < start) throw new HttpError(400, "End date cannot be before start date");
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > MAX_RENTAL_DAYS) throw new HttpError(400, `Maximum rental period is ${MAX_RENTAL_DAYS} days`);
  return { start, end, days };
}

function calculateTotal(equipment, days, quantity) {
  const units =
    equipment.rentalType === "Daily" ? days : equipment.rentalType === "Weekly" ? Math.ceil(days / 7) : Math.ceil(days / 30);
  return { units, total: money(units * equipment.price * quantity) };
}

// Use the website the request came from (localhost or Vercel) if it is allowed
const clientBase = (req) => (CLIENT_URLS.includes(req.headers.origin) ? req.headers.origin : CLIENT_URLS[0]);

async function createCheckoutSession(booking, customerEmail, baseUrl) {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: customerEmail,
    client_reference_id: booking._id.toString(),
    metadata: { bookingId: booking._id.toString() },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(booking.totalAmount * 100),
          product_data: {
            name: `${booking.equipmentName} x${booking.quantity}`,
            description: `Rental: ${booking.startDate.toISOString().slice(0, 10)} to ${booking.endDate.toISOString().slice(0, 10)}`,
          },
        },
      },
    ],
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: `${baseUrl}/payment/success?booking_id=${booking._id}`,
    cancel_url: `${baseUrl}/payment/cancel?booking_id=${booking._id}`,
  });
  await col.bookings.updateOne(
    { _id: booking._id },
    { $set: { stripeSessionId: session.id, holdUntil: new Date(Date.now() + HOLD_MS) } }
  );
  return session;
}

// ---------------------------------------------------------------------
// 6. APP + STRIPE WEBHOOK (must be BEFORE express.json)
// ---------------------------------------------------------------------
const app = express();
app.use(helmet());
app.use(
  cors({
    origin: CLIENT_URLS,
    credentials: true,
  })
);

async function markBookingPaid(session) {
  const bookingId = session.metadata?.bookingId;
  if (!bookingId || !ObjectId.isValid(bookingId)) return;
  const booking = await col.bookings.findOne({ _id: new ObjectId(bookingId) });
  if (!booking) return;
  // Verify the amount Stripe charged really matches our booking
  if (session.amount_total !== Math.round(booking.totalAmount * 100)) {
    console.error("Stripe amount mismatch for booking", bookingId);
    return;
  }
  const result = await col.bookings.updateOne(
    { _id: booking._id, paymentStatus: { $ne: "paid" } },
    { $set: { paymentStatus: "paid", status: "confirmed", paidAt: new Date(), transactionId: session.payment_intent || session.id } }
  );
  if (result.modifiedCount === 0) return; // already processed (webhook retry)
  await col.payments.updateOne(
    { sessionId: session.id },
    {
      $setOnInsert: {
        bookingId: booking._id,
        customerId: booking.customerId,
        ownerId: booking.ownerId,
        equipmentId: booking.equipmentId,
        sessionId: session.id,
        paymentIntentId: session.payment_intent || null,
        amount: money(session.amount_total / 100),
        currency: session.currency,
        status: "paid",
        customerEmail: session.customer_details?.email || session.customer_email || "",
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

app.post(
  "/api/webhook/stripe",
  express.raw({ type: "application/json" }),
  wrap(async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) throw new HttpError(500, "Webhook secret is not configured");
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
    } catch {
      return res.status(400).send("Invalid webhook signature");
    }

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      if (session.payment_status === "paid") await markBookingPaid(session);
    } else if (event.type === "checkout.session.expired") {
      const bookingId = event.data.object.metadata?.bookingId;
      if (bookingId && ObjectId.isValid(bookingId)) {
        await col.bookings.updateOne(
          { _id: new ObjectId(bookingId), paymentStatus: "unpaid", status: "pending" },
          { $set: { status: "cancelled", paymentStatus: "expired" } }
        );
      }
    }
    res.json({ received: true });
  })
);

app.use(express.json({ limit: "10mb" }));

// ---------------------------------------------------------------------
// 7. ROUTES - HEALTH
// ---------------------------------------------------------------------
app.get("/", (req, res) => res.json({ status: "ok", message: "Equipment Rental API is running" }));

// ---------------------------------------------------------------------
// 8. ROUTES - AUTH
// ---------------------------------------------------------------------
// Register: role is ALWAYS "customer". Role changes only through admin API.
app.post(
  "/api/auth/register",
  wrap(async (req, res) => {
    const name = str(req.body.name, 80);
    const email = str(req.body.email, 120).toLowerCase();
    const photoURL = str(req.body.photoURL, 500);
    if (!name) throw new HttpError(400, "Name is required");
    if (!isEmail(email)) throw new HttpError(400, "Valid email is required");
    const passError = validatePassword(req.body.password);
    if (passError) throw new HttpError(400, passError);
    if (await col.users.findOne({ email })) throw new HttpError(409, "An account with this email already exists");

    const user = {
      name,
      email,
      passwordHash: await bcrypt.hash(req.body.password, 10),
      role: "customer",
      photoURL,
      phone: "",
      provider: "password",
      createdAt: new Date(),
    };
    const result = await col.users.insertOne(user);
    user._id = result.insertedId;
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  })
);

app.post(
  "/api/auth/login",
  wrap(async (req, res) => {
    const email = str(req.body.email, 120).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = await col.users.findOne({ email });
    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(401, "Invalid email or password");
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

// Google login: frontend sends the Google ID token (credential)
app.post(
  "/api/auth/google",
  wrap(async (req, res) => {
    if (!GOOGLE_CLIENT_ID) throw new HttpError(500, "Google login is not configured");
    const idToken = str(req.body.idToken, 4000);
    if (!idToken) throw new HttpError(400, "idToken is required");

    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verify.ok) throw new HttpError(401, "Invalid Google token");
    const g = await verify.json();
    if (g.aud !== GOOGLE_CLIENT_ID || g.email_verified !== "true") throw new HttpError(401, "Google token rejected");

    const email = g.email.toLowerCase();
    let user = await col.users.findOne({ email });
    if (!user) {
      user = {
        name: g.name || email.split("@")[0],
        email,
        role: "customer", // Google signup is always customer
        photoURL: g.picture || "",
        phone: "",
        provider: "google",
        createdAt: new Date(),
      };
      user._id = (await col.users.insertOne(user)).insertedId;
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

// Persistent login: frontend calls this on reload with the saved token
app.get("/api/auth/me", verifyToken, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch(
  "/api/users/me",
  verifyToken,
  wrap(async (req, res) => {
    const update = {};
    if (req.body.name !== undefined) {
      update.name = str(req.body.name, 80);
      if (!update.name) throw new HttpError(400, "Name cannot be empty");
    }
    if (req.body.photoURL !== undefined) update.photoURL = str(req.body.photoURL, 500);
    if (req.body.phone !== undefined) update.phone = str(req.body.phone, 30);
    if (!Object.keys(update).length) throw new HttpError(400, "Nothing to update");
    await col.users.updateOne({ _id: req.user._id }, { $set: update }); // role is never updatable here
    const user = await col.users.findOne({ _id: req.user._id });
    res.json({ user: publicUser(user) });
  })
);

// ---------------------------------------------------------------------
// 17. 404 + ERROR HANDLER
// ---------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` }));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid JSON body" });
  if (err.type === "entity.too.large") return res.status(413).json({ message: "Request body too large" });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: status >= 500 && !(err instanceof HttpError) ? "Internal server error" : err.message });
});

// ---------------------------------------------------------------------
// 18. START
// ---------------------------------------------------------------------
connectDB()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch((err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });
