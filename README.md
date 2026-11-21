# Equipment Rental Platform — RentGear Server

## Project

RentGear is the backend REST API for an equipment-rental marketplace. It connects customers
with equipment owners and provides listing moderation, date-aware reservations, Stripe Checkout,
and role-specific dashboards.

- **Purpose:** secure API for the RentGear equipment rental platform.
- **Live API URL:** https://equipment-rental-server-two.vercel.app
- **Live client URL:** https://equipment-rental-client-nine.vercel.app
- **Client project:** `../equipment-rental-client`

### Submission details (Assignment 9 — Category 003)
- **Admin Email:** `mhabuhanif230@gmail.com`
- **Admin Password:** `Hanif15387126` _(demo credential for evaluator only)_
- **Live Site Link:** https://equipment-rental-client-nine.vercel.app
- **GitHub Repository (server):** https://github.com/mdabuhanif230/Equipment-Rental-Server
- **GitHub Repository (client):** https://github.com/mdabuhanif230/-Equipment-Rental-Client-

## Features

- Better Auth email/password and Google authentication with JWTs for protected API requests.
- Customer, owner, and admin authorization middleware.
- Equipment search, filtering, sorting, pagination, favorites, and reviews.
- Owner listings, admin approvals, bookings, and availability checks.
- Stripe Checkout, verified payment records, and booking status updates.
- Admin and owner dashboard analytics.
- Admin user management: role changes plus suspend/restore (suspended accounts are rejected by `verifyToken`).
- `node-cron` job that expires unpaid holds and completes rentals after their end date.
- Optional Resend email notifications to renters and owners when a rental is completed.
- Idempotent `npm run seed` script for demo equipment and homepage reviews.

## Run
```bash
npm install
# copy .env.example to .env and configure it
npm run dev
# optional: populate an empty database with demo equipment and reviews
npm run seed
```

## Setup
Copy `.env.example` to `.env` and set MongoDB, `JWT_SECRET`, `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, and Stripe values. Use separate random values for the two secrets.
MongoDB credentials are read only from environment variables; the server does not contain a
database password or hard-coded cluster host. Set `DB_NAME` to `equipment_rental` (or your
preferred database name).

Set `CLIENT_URLS` to a comma-separated list of allowed frontend origins. For Google login, set
the same OAuth Web Client ID in the server's `GOOGLE_CLIENT_ID` and the client's
`NEXT_PUBLIC_GOOGLE_CLIENT_ID`. The ID-token sign-in flow does not require a Google client secret;
if configured, `GOOGLE_CLIENT_SECRET` remains server-side and enables OAuth provider configuration.
New users choose either customer or equipment-owner access during sign-up. The first admin can be
created by adding that email to `ADMIN_EMAILS` before registration, or by promoting an account
directly in MongoDB.

The client defaults to `http://localhost:5000/api`. Start the API with `npm run dev` and the client with `npm run dev` from its own directory. The API expires abandoned checkout holds and marks paid rentals completed after their end date once per minute.

## Server structure

The backend is intentionally kept in `index.js`, like the supplied reference server, so the complete
request flow is easy to follow in one file. It is organized into sections for configuration and
helpers, authentication, equipment, favorites, bookings and payments, admin operations, reviews,
analytics, error handling, and startup/database indexes.

## Packages

Runtime: `express`, `cors`, `helmet`, `dotenv`, `mongodb`, `better-auth`,
`@better-auth/mongo-adapter`, `bcryptjs`, `jose`, `jsonwebtoken`, `node-cron`, and `stripe`.
Development: `nodemon`.

## Stripe webhook (optional, recommended for production)
```bash
stripe listen --forward-to localhost:5000/api/payments/webhook
```
Copy the `whsec_...` value into `STRIPE_WEBHOOK_SECRET`. The payment success page also verifies Checkout directly with Stripe, so local testing still works without a webhook listener.

## API overview
- Auth: Better Auth endpoints under `/api/auth` (`/sign-up/email`, `/sign-in/email`,
  `/one-tap/callback`, `/sign-in/social`, `/get-session`, `/token`); authenticated profile:
  `/api/users/me`
- Equipment: `/api/equipment`, `/api/equipment/featured`, `/api/equipment/categories`,
  `/api/equipment/:id`, `/api/equipment/:id/availability`
- Customer: `/api/favorites`, `/api/bookings/my`, `/api/stats/customer`
- Owner: `/api/owner/equipment`, `/api/bookings/owner`, `/api/stats/owner`
- Admin: `/api/admin/users` (role + suspend/restore), `/api/admin/equipment`, `/api/admin/bookings`,
  `/api/admin/bookings/:id/status`, `/api/stats/admin`
- Payments: `/api/bookings` (Stripe checkout), `/api/payments/webhook`
- Reviews: `/api/reviews`

The protected API uses Better Auth's JWT plugin together with `verifyToken`, `verifyRenter`,
`verifyOwner`, and `verifyAdmin`. On first startup, existing bcrypt password hashes are copied
into Better Auth credential accounts so current email/password accounts can continue signing in.
Public
equipment search supports `search`, `location`, `category`, `rentalType`, `minPrice`, `maxPrice`,
`available`, `sort`, `page`, and `limit`.
