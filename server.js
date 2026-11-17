const http = require("node:http");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 10000);
const codes = new Map();
const verified = new Map();
const sendWindows = new Map();
const bookingWindows = new Map();
const GMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 32 * 1024;
const MAX_PROOF_BODY = 7 * 1024 * 1024;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ALLOWED_PROOF_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function readJson(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function clean(value, max = 3000) {
  return String(value || "")
    .trim()
    .slice(0, max);
}
function resendReady() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}
async function sendEmail({ to, subject, html, text, replyTo, attachments }) {
  if (!resendReady())
    throw Object.assign(
      new Error("Email service is not configured yet. Please contact the site administrator."),
      { status: 503 },
    );
  const payload = {
    from: process.env.RESEND_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;
  if (attachments?.length) payload.attachments = attachments;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Resend email send failed:", response.status, detail.slice(0, 500));
    throw Object.assign(
      new Error("Email could not be sent. Please try again later or contact the resort."),
      { status: 502 },
    );
  }
  return response.json();
}
function canSendCode(address, ip) {
  const key = `${ip}:${address}`;
  const now = Date.now();
  const recent = (sendWindows.get(key) || []).filter(
    (time) => now - time < 60 * 60 * 1000,
  );
  if (
    recent.length >= 5 ||
    (recent.length && now - recent[recent.length - 1] < 60 * 1000)
  )
    return false;
  recent.push(now);
  sendWindows.set(key, recent);
  return true;
}
function canSendBookingNotice(kind, ip, email) {
  const key = `${kind}:${ip}:${email}`;
  const now = Date.now();
  const recent = (bookingWindows.get(key) || []).filter(
    (time) => now - time < 60 * 60 * 1000,
  );
  if (recent.length >= 5 || (recent.length && now - recent[recent.length - 1] < 15000))
    return false;
  recent.push(now);
  bookingWindows.set(key, recent);
  return true;
}
function bookingFields(data) {
  const name = clean(data.name, 120);
  const email = clean(data.email, 254).toLowerCase();
  const phone = clean(data.phone, 80);
  const bookingReference = clean(data.bookingReference, 100).replace(/[\r\n]+/g, " ");
  const staySummary = clean(data.staySummary, 500) || "No requested stay details provided.";
  if (!name || !EMAIL_RE.test(email) || !phone || !bookingReference) return null;
  return { name, email, phone, bookingReference, staySummary };
}
function bookingHtml(title, guest, extra = "") {
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#26332e"><h2>${escapeHtml(title)}</h2><p><b>Guest:</b> ${escapeHtml(guest.name)}</p><p><b>Email:</b> ${escapeHtml(guest.email)}</p><p><b>Phone:</b> ${escapeHtml(guest.phone)}</p><p><b>Request reference:</b> ${escapeHtml(guest.bookingReference)}</p><p><b>Requested stay:</b> ${escapeHtml(guest.staySummary)}</p>${extra}</div>`;
}
async function api(req, res, pathname) {
  if (req.method !== "POST")
    return json(res, 405, { error: "Method not allowed." });
  const maxBytes = pathname === "/api/payment-proof" ? MAX_PROOF_BODY : MAX_BODY;
  let data;
  try {
    data = await readJson(req, maxBytes);
  } catch (error) {
    return json(res, error.status || 400, {
      error:
        error.status === 413
          ? "Request is too large. Payment proof files must be 5 MB or smaller."
          : "Invalid request.",
    });
  }

  if (pathname === "/api/send-verification") {
    const email = clean(data.email, 254).toLowerCase();
    if (!GMAIL_RE.test(email))
      return json(res, 400, {
        error: "Enter a valid Gmail address ending in @gmail.com.",
      });
    if (!resendReady())
      return json(res, 503, {
        error: "Email verification is not configured yet. Please contact the site administrator.",
      });
    if (!canSendCode(email, req.socket.remoteAddress || "unknown"))
      return json(res, 429, {
        error: "Please wait a minute before requesting another code. Up to 5 codes per hour are allowed.",
      });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    codes.set(email, {
      hash: crypto.createHash("sha256").update(code).digest("hex"),
      expires: Date.now() + 10 * 60 * 1000,
      attempts: 0,
    });
    try {
      await sendEmail({
        to: email,
        subject: "Your Cala Laiya email verification code",
        text: `Your Cala Laiya verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:32px auto;color:#26332e"><p style="letter-spacing:.18em;color:#9b754e;font-size:12px">CALA LAIYA BEACH RESORT</p><h2>Verify your email</h2><p>Enter this code on the contact form to confirm that you can access this Gmail inbox:</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px;padding:16px;background:#f6f3ed;text-align:center">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>`,
      });
      return json(res, 200, { ok: true, message: "Verification code sent. Check your Gmail inbox." });
    } catch (error) {
      codes.delete(email);
      return json(res, error.status || 502, {
        error: error.message || "Could not send the verification email.",
      });
    }
  }

  if (pathname === "/api/verify-code") {
    const email = clean(data.email, 254).toLowerCase();
    const code = clean(data.code, 12);
    if (!GMAIL_RE.test(email) || !/^\d{6}$/.test(code))
      return json(res, 400, { error: "Enter the Gmail address and the 6-digit code." });
    const record = codes.get(email);
    if (!record || record.expires < Date.now()) {
      codes.delete(email);
      return json(res, 400, { error: "That code is missing or expired. Request a new one." });
    }
    record.attempts += 1;
    const candidate = crypto.createHash("sha256").update(code).digest();
    const expected = Buffer.from(record.hash, "hex");
    if (record.attempts > 5 || !crypto.timingSafeEqual(candidate, expected)) {
      if (record.attempts >= 5) codes.delete(email);
      return json(res, 400, { error: "That code is incorrect or expired. Check the code and try again." });
    }
    codes.delete(email);
    verified.set(email, Date.now() + 20 * 60 * 1000);
    return json(res, 200, { ok: true, message: "Gmail inbox verified. You can now send your inquiry." });
  }

  if (pathname === "/api/contact") {
    const name = clean(data.name, 120);
    const email = clean(data.email, 254).toLowerCase();
    const phone = clean(data.phone, 80);
    const message = clean(data.message, 5000);
    if (!name || !GMAIL_RE.test(email) || !phone || !message)
      return json(res, 400, { error: "Please complete all fields using a valid Gmail address." });
    const verificationExpires = verified.get(email) || 0;
    if (verificationExpires < Date.now()) {
      verified.delete(email);
      return json(res, 403, { error: "Verify access to your Gmail inbox before sending your inquiry." });
    }
    const destination = process.env.CONTACT_TO || "reservations@calalaiyabeach-resort.com";
    const subject = `Cala Laiya inquiry from ${name.replace(/[\r\n]+/g, " ").slice(0, 100)}`;
    const text = `Full Name: ${name}\nEmail: ${email}\nContact No.: ${phone}\n\n${message}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#26332e"><h2>Website inquiry</h2><p><b>Full name:</b> ${escapeHtml(name)}</p><p><b>Email:</b> ${escapeHtml(email)}</p><p><b>Contact number:</b> ${escapeHtml(phone)}</p><p><b>Message:</b></p><p style="white-space:pre-wrap">${escapeHtml(message)}</p></div>`;
    try {
      await sendEmail({ to: destination, replyTo: email, subject, text, html });
      verified.delete(email);
      return json(res, 200, { ok: true, message: "Your verified inquiry has been emailed to Cala Laiya." });
    } catch (error) {
      return json(res, error.status || 502, { error: error.message || "Could not send your inquiry." });
    }
  }

  if (pathname === "/api/booking-notification" || pathname === "/api/payment-proof") {
    const guest = bookingFields(data);
    if (!guest)
      return json(res, 400, {
        error: "Enter a valid guest name, email, phone number, and booking reference.",
      });
    const consentGiven =
      pathname === "/api/payment-proof" ? data.proofConsent === true : data.consent === true;
    if (!consentGiven)
      return json(res, 400, { error: "Consent is required before sending these details to the resort." });
    const kind = pathname === "/api/payment-proof" ? "proof" : "booking";
    if (!canSendBookingNotice(kind, req.socket.remoteAddress || "unknown", guest.email))
      return json(res, 429, { error: "Please wait before sending another notification." });
    const destination =
      process.env.BOOKING_NOTIFY_TO ||
      process.env.CONTACT_TO ||
      "reservations@calalaiyabeach-resort.com";
    const isProof = kind === "proof";
    let attachments;
    let extraText = "";
    let extraHtml = "";
    if (isProof) {
      const mimeType = clean(data.mimeType, 80).toLowerCase();
      const fileName = clean(data.fileName, 160).replace(/[^a-zA-Z0-9._-]/g, "_") || "payment-proof";
      const fileBase64 = clean(data.fileBase64, MAX_PROOF_BODY);
      if (!ALLOWED_PROOF_TYPES.has(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileBase64))
        return json(res, 400, { error: "Upload a JPG, PNG, WebP, or PDF payment proof file." });
      const fileBuffer = Buffer.from(fileBase64, "base64");
      if (!fileBuffer.length || fileBuffer.length > MAX_PROOF_BYTES)
        return json(res, 400, { error: "Payment proof must be a non-empty file of 5 MB or smaller." });
      const signatureMatches =
        (mimeType === "application/pdf" && fileBuffer.subarray(0, 5).toString() === "%PDF-") ||
        (mimeType === "image/png" && fileBuffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
        (mimeType === "image/jpeg" && fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff) ||
        (mimeType === "image/webp" && fileBuffer.subarray(0, 4).toString() === "RIFF" && fileBuffer.subarray(8, 12).toString() === "WEBP");
      if (!signatureMatches)
        return json(res, 400, { error: "The uploaded file does not match its selected image or PDF type." });
      attachments = [{ filename: fileName, content: fileBuffer.toString("base64") }];
      extraText = `\nPayment proof attached: ${fileName}`;
      extraHtml = `<p><b>Payment proof:</b> attached (${escapeHtml(fileName)})</p>`;
    }
    const title = isProof ? "Payment proof uploaded" : "Manual reservation request submitted";
    const subject = `${title} — ${guest.bookingReference}`;
    const text = `Cala Laiya ${title.toLowerCase()}\nGuest: ${guest.name}\nEmail: ${guest.email}\nPhone: ${guest.phone}\nRequest reference: ${guest.bookingReference}\nRequested stay: ${guest.staySummary}${extraText}`;
    try {
      await sendEmail({
        to: destination,
        replyTo: guest.email,
        subject,
        text,
        html: bookingHtml(title, guest, extraHtml),
        attachments,
      });
      return json(res, 200, {
        ok: true,
        message: isProof ? "Payment proof sent to the resort." : "Manual reservation request sent to the resort.",
      });
    } catch (error) {
      return json(res, error.status || 502, { error: error.message || "Could not send the notification." });
    }
  }
  return json(res, 404, { error: "Not found." });
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const configured = (process.env.CORS_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowAll = configured.includes("*");
  if (origin && !allowAll && !configured.includes(origin)) {
    json(res, 403, { error: "This website is not allowed to use the email API." });
    return false;
  }
  if (allowAll) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}
http
  .createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
    if (!applyCors(req, res)) return;
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === "/health" && req.method === "GET")
      return json(res, 200, { ok: true, service: "cala-laiya-email-api" });
    if (pathname.startsWith("/api/")) return api(req, res, pathname);
    return json(res, 404, { error: "Not found." });
  })
  .listen(port, "0.0.0.0", () =>
    console.log(`Cala Laiya email API ready on port ${port}`),
  );
