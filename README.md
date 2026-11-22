# Equipment Rental Platform - RentGear API

This repository contains the Express/MongoDB backend for the RentGear equipment rental
marketplace. It provides authentication, role authorization, equipment management, availability
checks, favorites, reviews, bookings, Stripe Checkout, analytics, and administrative operations.

## Live Project

- **Live API:** https://equipment-rental-server.onrender.com
- **API Health:** https://equipment-rental-server.onrender.com/api/health
- **Live Client:** https://rentgear-ivory.vercel.app
- **Server Repository:** https://github.com/mdabuhanif230/Equipment-Rental-Server
- **Client Repository:** https://github.com/mdabuhanif230/Equipment-Rental-Client

## Assignment Submission

| Item | Details |
| --- | --- |
| Project | RentGear - Equipment Rental Platform |
| Assignment | Assignment 9 - Category 003 |
| Admin Credentials | Available to the project owner only |
| Live API | https://equipment-rental-server.onrender.com |
| Live Site | https://rentgear-ivory.vercel.app |

## Features

### Authentication

- Email/password registration and sign-in
- Better Auth MongoDB adapter
- Password validation and bcrypt hashing
- Google ID-token verification
- JWT bearer tokens for protected REST requests
- Secure customer, owner, and admin route authorization
- Legacy password-account migration

### Equipment

- Approved equipment catalogue
- Featured and category endpoints
- Server-side name/location search
- Category, rental type, price, availability, and sorting filters
- Pagination
- Live date-and-quantity availability calculation
- Owner listing creation and updates
- Admin approval and rejection
- ImgBB and direct image URL support

### Customer

- Favorites stored in MongoDB
- Rental booking creation
- 35-minute booking hold
- Completed-rental review restrictions
- Customer rental and spending analytics

### Owner

- Owner-specific equipment inventory
- Owner rental history
- Completed-rental and earnings analytics
- Monthly earnings aggregation

### Admin

- User search and role filtering
- Customer, owner, and admin role changes
- Account suspend and restore
- Platform-wide equipment moderation
- Platform-wide booking management
- User, equipment, booking, revenue, and monthly statistics

### Payments and Automation

- Stripe Checkout sessions
- Stripe test-mode support
- Server-side payment verification
- `payments` collection transaction records
- `checkout.session.completed` and async success webhook handling
- Booking hold expiration
- Automatic rental completion after end date
- Optional Resend notification emails

## Technology Stack

| Area | Package |
| --- | --- |
| Server | Express.js |
| Database | MongoDB and MongoDB Atlas |
| Authentication | Better Auth |
| Password Security | bcryptjs |
| JWT | jsonwebtoken and jose |
| Payment | Stripe |
| Scheduling | node-cron |
| Security | Helmet and CORS |
| Configuration | dotenv |

## Local Setup

Requirements:

- Node.js 20 or newer
- MongoDB or MongoDB Atlas
- Stripe test account
- Google OAuth Web Client ID, if Google login is required

```bash
npm install
cp .env.example .env.local
npm run dev
```

The API runs at `http://localhost:5000` by default.

## Environment Variables

Create `.env.local` from `.env.example`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Express listening port |
| `MONGODB_URI` | MongoDB Atlas or local MongoDB connection string |
| `DB_NAME` | MongoDB database name |
| `JWT_SECRET` | Bearer access-token signing secret |
| `BETTER_AUTH_URL` | Public authentication base URL |
| `BETTER_AUTH_SECRET` | Better Auth signing secret |
| `CLIENT_URLS` | Comma-separated allowed client origins |
| `NEXT_PUBLIC_SITE_URL` | Main client URL used for payment return links |
| `GOOGLE_CLIENT_ID` | Google OAuth Web Client ID |
| `GOOGLE_CLIENT_SECRET` | Optional OAuth server credential |
| `ADMIN_EMAILS` | Comma-separated first-admin emails |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe `whsec_...` webhook signing secret |
| `RESEND_API_KEY` | Optional Resend API key |
| `EMAIL_FROM` | Optional sender address |

Do not commit `.env.local`, database credentials, JWT secrets, OAuth secrets, or Stripe secrets.

## Stripe Configuration

Create a Stripe webhook endpoint pointing to:

```text
https://equipment-rental-server.onrender.com/api/stripe/webhook
```

Enable these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`

Store the generated signing secret in `STRIPE_WEBHOOK_SECRET`. The local equivalent is:

```text
http://localhost:5000/api/stripe/webhook
```

Test cards:

| Field | Value |
| --- | --- |
| Card | `4242 4242 4242 4242` |
| Expiry | Any future date |
| CVC | Any three digits |
| ZIP | Any five digits |

## API Overview

### Authentication

| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/api/auth/local/sign-up` | Public |
| POST | `/api/auth/local/sign-in` | Public |
| POST | `/api/auth/local/refresh` | Bearer token |
| POST | `/api/auth/google/callback` | Public |
| GET | `/api/auth/get-session` | Session |
| GET | `/api/auth/token` | Session |
| GET | `/api/users/me` | Authenticated |
| PATCH | `/api/users/me` | Authenticated |

### Equipment

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/equipment/featured` | Public |
| GET | `/api/equipment/categories` | Public |
| GET | `/api/equipment` | Public |
| GET | `/api/equipment/:id` | Public/owner/admin-aware |
| GET | `/api/equipment/:id/availability` | Public |
| POST | `/api/equipment` | Owner |
| PUT | `/api/equipment/:id` | Owner |
| DELETE | `/api/equipment/:id` | Owner/admin |

Public equipment filtering parameters:

```text
search, location, category, rentalType, minPrice, maxPrice,
available, sort, page, limit
```

Sorting values:

- `newest`
- `price_asc`
- `price_desc`

### Customer

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/favorites/ids` | Customer |
| GET | `/api/favorites` | Customer |
| POST | `/api/favorites/:id` | Customer |
| DELETE | `/api/favorites/:id` | Customer |
| GET | `/api/bookings/my` | Customer |
| POST | `/api/bookings` | Customer |
| POST | `/api/bookings/:id/pay` | Customer |
| PATCH | `/api/bookings/:id/cancel` | Customer |
| POST | `/api/bookings/:id/verify` | Customer |
| POST | `/api/reviews` | Customer |
| GET | `/api/stats/customer` | Customer |

### Owner

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/owner/equipment` | Owner |
| GET | `/api/bookings/owner` | Owner |
| PATCH | `/api/bookings/:id/status` | Owner |
| GET | `/api/stats/owner` | Owner |

### Admin

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/admin/users` | Admin |
| PATCH | `/api/admin/users/:id/role` | Admin |
| PATCH | `/api/admin/users/:id/ban` | Admin |
| GET | `/api/admin/equipment` | Admin |
| PATCH | `/api/admin/equipment/:id/status` | Admin |
| PUT | `/api/admin/equipment/:id` | Admin |
| DELETE | `/api/admin/equipment/:id` | Admin |
| GET | `/api/admin/bookings` | Admin |
| PATCH | `/api/admin/bookings/:id/status` | Admin |
| GET | `/api/stats/admin` | Admin |

## Scripts

```bash
npm run dev
npm start
npm run seed
node --check index.js
```

## Project Structure

```text
index.js       Express app, routes, middleware, jobs, and startup
.env.example   Environment variable template
package.json   Dependencies and npm scripts
README.md      API documentation
```
