# Equipment Rental Platform — Server

Single-file Express backend (`index.js`) with MongoDB, JWT, Stripe, ImgBB.

## Run
```bash
npm install
# edit .env
npm run dev
```

## Setup
`.env` has only PORT, DB_USER, DB_PASSWORD, STRIPE_SECRET_KEY, RESEND_API_KEY.
Edit DB_CLUSTER, CLIENT_URLS, GOOGLE_CLIENT_ID at the top of index.js.
Make the first admin: register normally, then in MongoDB Atlas set that user's `role` to `admin`.

## Stripe webhook (optional, recommended for production)
```bash
stripe listen --forward-to localhost:5000/api/webhook/stripe
```
Copy the `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

## API overview
Auth: POST /api/auth/register, /login, /google · GET /api/auth/me · PATCH /api/users/me
Equipment: GET /api/equipment (search, location, category, rentalType, minPrice, maxPrice, available, sort, page, limit),
  /featured, /categories, /:id, /:id/availability, /:id/reviews · POST, PUT /:id, DELETE /:id (owner)
Owner: GET /api/owner/equipment, /api/bookings/owner, /api/stats/owner · PATCH /api/bookings/:id/status
Favorites: GET /api/favorites, /ids · POST, DELETE /api/favorites/:equipmentId
Bookings: POST /api/bookings · GET /my, /:id · POST /:id/pay, /:id/verify · PATCH /:id/cancel
Reviews: GET/POST /api/reviews
Admin: /api/admin/users, /users/:id/role, /equipment, /equipment/:id/status, /bookings, /api/stats/admin
Webhook: POST /api/webhook/stripe
