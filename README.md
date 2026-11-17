# Cala Laiya email API (Render)

This is the separate backend for the static Cala Laiya frontend. It sends email-verification codes and verified contact-form inquiries, and it emails manual reservation requests (including selected stay details) and payment-proof uploads to the resort reservations team.

## Deploy on Render

1. Unzip this package into its own Git repository and push that repository to GitHub (Render deploys web services from a connected Git repository).
2. In Render, create a **New Web Service** from that repository. The included `render.yaml` defines the Node runtime, `npm install`, `npm start`, the `/health` check, and the Singapore region.
3. Add `RESEND_API_KEY` and `RESEND_FROM` in the Render service's Environment settings. `RESEND_FROM` must use a sender address on a domain verified in Resend, for example `Cala Laiya <website@your-verified-domain.com>`. Keep the API key server-side; do not add it to the frontend. Set `BOOKING_NOTIFY_TO` to the notification recipient (defaults to `reservations@calalaiyabeach-resort.com`).
4. After deployment, copy the service URL, such as `https://cala-laiya-email-api.onrender.com`.
5. In the frontend package, set `window.CALA_API_BASE_URL` in `api-config.js` to that URL (no trailing slash), then upload/redeploy the frontend to Vercel.
6. After Vercel gives you the public URL, set `CORS_ORIGINS` in Render to that exact origin, for example `https://your-project.vercel.app` (no path or trailing slash), then redeploy/restart the backend. Do not leave the wildcard default for production.

## Local run

Requires Node.js 20 or newer. Set the email values and run:

```sh
RESEND_API_KEY=re_your_key \
RESEND_FROM='Cala Laiya <website@your-verified-domain.com>' \
CONTACT_TO='reservations@calalaiyabeach-resort.com' \
npm start
```

The API listens on `PORT` (default `10000`) and `0.0.0.0`, as required for a Render web service. Check `GET /health` for service health.

## Routes

- `POST /api/send-verification` with `{ "email": "guest@gmail.com" }` sends a 6-digit, 10-minute code. It limits code sends to one per minute and five per hour per source/email pair.
- `POST /api/verify-code` with `{ "email": "guest@gmail.com", "code": "123456" }` verifies inbox access.
- `POST /api/contact` with `{ "name": "Guest", "email": "guest@gmail.com", "phone": "+63...", "message": "..." }` emails an inquiry only after verification.
- `POST /api/booking-notification` with guest name, email, phone, generated request reference, requested stay summary, and consent emails a manual request to `BOOKING_NOTIFY_TO`.
- `POST /api/payment-proof` with the same guest/request fields, proof consent, and a base64-encoded JPG, PNG, WebP, or PDF (up to 5 MB) emails the payment proof as an attachment.

Booking notifications are emails only: this API does not check room availability, create/confirm reservations, or keep booking records. The resort must confirm each request manually. The payment proof is attached to the notification email and is not retained as a booking record by this service. The endpoints are rate-limited and require the guest’s consent field. Verification codes and verified status are kept in process memory. Run a single service instance; a restart or scale-out can discard verification state.
