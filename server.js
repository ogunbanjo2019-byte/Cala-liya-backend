const http = require("node:http");
const crypto = require("node:crypto");
const { checkAvailability, reserve } = require("./controllers/booking-controller");
const bookingStore = require("./models/booking-store");

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
function paymentMethod(value) {
  const method = clean(value, 40).toLowerCase();
  return method === "card" || method === "bank-transfer" ? method : null;
}
function bookingHtml(title, guest, extra = "") {
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#26332e"><h2>${escapeHtml(title)}</h2><p><b>Guest:</b> ${escapeHtml(guest.name)}</p><p><b>Email:</b> ${escapeHtml(guest.email)}</p><p><b>Phone:</b> ${escapeHtml(guest.phone)}</p><p><b>Request reference:</b> ${escapeHtml(guest.bookingReference)}</p><p><b>Requested stay:</b> ${escapeHtml(guest.staySummary)}</p>${extra}</div>`;
}
const SITE_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cala Laiya | Reserve your stay</title>
<style>
:root{--ink:#20352f;--muted:#66756f;--cream:#f7f3ec;--sand:#c99a62;--line:#e2ddd3;--white:#fff}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{min-height:100vh;display:flex;justify-content:center;padding:48px 20px}.shell{width:min(780px,100%)}.eyebrow{letter-spacing:.22em;color:var(--sand);font-size:11px;font-weight:800}.brand{font-family:Georgia,serif;font-size:clamp(38px,7vw,70px);line-height:1;margin:12px 0 10px}.intro{color:var(--muted);max-width:590px;line-height:1.65}.card{background:var(--white);border:1px solid var(--line);border-radius:24px;padding:clamp(22px,5vw,44px);margin-top:30px;box-shadow:0 20px 60px #30463c12}.steps{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px}.step{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:8px 12px}.step.active{background:var(--ink);border-color:var(--ink);color:#fff}h2{font:32px Georgia,serif;margin:0 0 9px}h3{font-size:18px;margin:26px 0 12px}p{line-height:1.55}.notice{padding:16px 18px;border-radius:14px;background:#edf5ef;border:1px solid #cfe3d3;margin:20px 0;color:#2d5c3d}.notice.warn{background:#fff7e8;border-color:#ead5a8;color:#79571e}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.field{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}.field.full{grid-column:1/-1}label{font-size:13px;font-weight:700}input,select{width:100%;border:1px solid #d8d5cf;border-radius:11px;padding:13px 14px;font:inherit;background:#fff;color:var(--ink)}input:focus,select:focus{outline:3px solid #c99a6230;border-color:var(--sand)}button{border:0;border-radius:12px;padding:14px 18px;font:700 14px inherit;cursor:pointer;background:var(--ink);color:#fff}button.secondary{background:#eeeae3;color:var(--ink)}button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;gap:12px;justify-content:flex-end;margin-top:10px}.payment{border:1px solid var(--line);border-radius:15px;padding:18px;margin:12px 0;display:flex;gap:14px;align-items:flex-start;cursor:pointer}.payment input{width:auto;margin-top:4px}.payment strong{display:block;margin-bottom:4px}.payment small{color:var(--muted)}.hidden{display:none!important}.summary{background:#faf8f4;border-radius:14px;padding:15px;margin:18px 0;color:var(--muted);font-size:14px}.error{color:#a23e30;margin:12px 0;font-size:14px}.support{color:var(--muted);font-size:13px;margin-top:20px}.support a{color:var(--ink);font-weight:700}@media(max-width:600px){.grid{grid-template-columns:1fr}.field.full{grid-column:auto}.actions{flex-direction:column}.actions button{width:100%}}
</style></head><body><main><section class="shell"><div class="eyebrow">CALA LAIYA BEACH RESORT</div><div class="brand">Reserve your stay.</div><p class="intro">Choose your room and dates to check availability. Once available, add your guest details, reserve your stay, and complete payment by bank transfer.</p><div class="card"><div class="steps"><span class="step active" data-step="1">1. Room</span><span class="step" data-step="2">2. Guest details</span><span class="step" data-step="3">3. Payment</span></div>
<section id="roomStep"><h2>Check availability</h2><p class="intro">Select a room option and dates. This will only check availability — it will not send a reservation request.</p><div class="grid"><div class="field full"><label for="room">Room option</label><select id="room"><option value="">Select a room</option><option>Seaview Suite</option><option>Garden Villa</option><option>Beachfront Cottage</option></select></div><div class="field"><label for="checkIn">Check-in</label><input id="checkIn" type="date"></div><div class="field"><label for="checkOut">Check-out</label><input id="checkOut" type="date"></div><div class="field full"><label for="guests">Guests</label><input id="guests" placeholder="e.g. 2 adults" maxlength="40"></div></div><div id="roomError" class="error"></div><div class="actions"><button id="checkBtn">Check availability</button></div><p class="support">Questions? <a href="mailto:reservations@calalaiyabeach-resort.com">Message our support</a>.</p></section>
<section id="guestStep" class="hidden"><h2>Booking is available</h2><div id="availabilityNotice" class="notice">Room is available for your selected dates. Kindly message our support if you have any questions.</div><div id="staySummary" class="summary"></div><h3>Guest details</h3><div class="grid"><div class="field"><label for="name">Full name</label><input id="name" autocomplete="name"></div><div class="field"><label for="phone">Phone number</label><input id="phone" autocomplete="tel"></div><div class="field full"><label for="email">Email address</label><input id="email" type="email" autocomplete="email"></div></div><label class="field full" style="display:flex;flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input id="bookingConsent" type="checkbox" style="width:auto;margin-top:3px"><span>I agree to send my guest and stay details to Cala Laiya so the resort can process this reservation request.</span></label><div id="guestError" class="error"></div><div class="actions"><button class="secondary" id="backRoom">Back</button><button id="reserveBtn">Reserve</button></div></section>
<section id="paymentStep" class="hidden"><h2>Choose payment method</h2><p class="intro">Your reservation details have been received. Select how you would like to pay.</p><div id="paymentNotice"></div><label class="payment"><input type="radio" name="payment" value="card"><span><strong>Card payment</strong><small>Pay securely by card. Card payment is currently unavailable.</small></span></label><label class="payment"><input type="radio" name="payment" value="bank-transfer"><span><strong>Bank transfer</strong><small>Transfer the amount using the resort bank details, then upload your payment receipt.</small></span></label><div id="bankDetails" class="notice hidden"><strong>Bank transfer</strong><br>Please complete your bank transfer using the resort’s official bank details, then upload your receipt below.</div><div id="receiptBox" class="hidden"><div class="field"><label for="receipt">Payment receipt</label><input id="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"></div><div id="receiptError" class="error"></div><div class="actions"><button class="secondary" id="backGuest">Back</button><button id="receiptBtn">Upload payment receipt</button></div></div></section>
<div id="successStep" class="hidden"><h2>Thank you</h2><div class="notice">Payment receipt sent to the resort. Your reservation will be reviewed by support.</div><p class="support">Keep your booking reference for follow-up with the resort.</p></div>
</div></section></main><script>
const $=id=>document.getElementById(id), state={};
function api(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>{const d=await r.json();if(!r.ok)throw Object.assign(new Error(d.error||'Something went wrong.'),{data:d});return d})}
function setStep(n){document.querySelectorAll('[data-step]').forEach(x=>x.classList.toggle('active',x.dataset.step===String(n)));['roomStep','guestStep','paymentStep','successStep'].forEach(id=>$(id).classList.add('hidden'));$(n===1?'roomStep':n===2?'guestStep':n===3?'paymentStep':'successStep').classList.remove('hidden')}
$('checkBtn').onclick=()=>{ $('roomError').textContent=''; if(!$('room').value||!$('checkIn').value||!$('checkOut').value){$('roomError').textContent='Select a room and valid dates.';return} api('/api/check-availability',{room:$('room').value,checkIn:$('checkIn').value,checkOut:$('checkOut').value,guests:$('guests').value}).then(d=>{if(!d.available)throw new Error(d.message);state.stay=d; $('availabilityNotice').textContent=d.message; $('staySummary').textContent=$('room').value+' · '+$('checkIn').value+' to '+$('checkOut').value+($('guests').value?' · '+$('guests').value:'');setStep(2)}).catch(e=>$('roomError').textContent=e.message)};
$('backRoom').onclick=()=>setStep(1); $('backGuest').onclick=()=>setStep(2);
$('reserveBtn').onclick=()=>{ $('guestError').textContent=''; const body={name:$('name').value,email:$('email').value,phone:$('phone').value,bookingReference:'CL-'+Date.now().toString(36).toUpperCase(),room:state.stay?.room,checkIn:state.stay?.checkIn,checkOut:state.stay?.checkOut,guests:state.stay?.guests,consent:$('bookingConsent').checked}; if(!body.name||!body.email||!body.phone||!body.consent){$('guestError').textContent='Complete your guest details and agree to share them with the resort.';return} $('reserveBtn').disabled=true; api('/api/reserve',body).then(d=>{state.guest=Object.assign({},body,{staySummary:$('staySummary').textContent});state.bookingReference=d.bookingReference;$('paymentNotice').innerHTML=d.notificationSent?'':'<div class="notice warn">'+d.message+' Reference: '+d.bookingReference+'</div>';setStep(3)}).catch(e=>$('guestError').textContent=e.message).finally(()=>$('reserveBtn').disabled=false)};
document.querySelectorAll('input[name="payment"]').forEach(r=>r.onchange=()=>{ $('paymentNotice').innerHTML=''; $('receiptError').textContent=''; api('/api/payment-method',{paymentMethod:r.value}).then(d=>{ $('bankDetails').classList.toggle('hidden',r.value!=='bank-transfer');$('receiptBox').classList.toggle('hidden',r.value!=='bank-transfer')}).catch(e=>{ $('paymentNotice').innerHTML='<div class="notice warn">'+e.message+'</div>'; document.querySelector('input[name="payment"][value="bank-transfer"]').checked=false; $('bankDetails').classList.add('hidden');$('receiptBox').classList.add('hidden')})});
$('receiptBtn').onclick=()=>{const file=$('receipt').files[0];$('receiptError').textContent='';if(!file){$('receiptError').textContent='Choose your payment receipt first.';return}if(file.size>5*1024*1024){$('receiptError').textContent='Payment receipt must be 5 MB or smaller.';return}const reader=new FileReader();reader.onload=()=>api('/api/payment-proof',Object.assign({},state.guest,{paymentMethod:'bank-transfer',proofConsent:true,fileName:file.name,mimeType:file.type,fileBase64:reader.result.split(',')[1]})).then(()=>setStep(4)).catch(e=>$('receiptError').textContent=e.message);reader.readAsDataURL(file)};
</script></body></html>`;
function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
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

  if (pathname === "/api/check-availability") {
    try {
      const result = await checkAvailability(data);
      return json(res, result.status, result.body);
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || "Could not check room availability." });
    }
  }

  if (pathname === "/api/reserve") {
    try {
      const result = await reserve(data, {
        allowNotice: (email) => canSendBookingNotice("booking", req.socket.remoteAddress || "unknown", email),
        notify: async (record) => {
          const destination = process.env.BOOKING_NOTIFY_TO || process.env.CONTACT_TO || "reservations@calalaiyabeach-resort.com";
          const guest = { ...record, staySummary: `${record.room} · ${record.checkIn} to ${record.checkOut}${record.guests ? ` · ${record.guests}` : ""}` };
          const text = `Reservation submitted\nGuest: ${record.name}\nEmail: ${record.email}\nPhone: ${record.phone}\nRequest reference: ${record.bookingReference}\nRoom: ${record.room}\nCheck-in: ${record.checkIn}\nCheck-out: ${record.checkOut}\nGuests: ${record.guests || "Not specified"}`;
          await sendEmail({ to: destination, replyTo: record.email, subject: `Reservation submitted — ${record.bookingReference}`, text, html: bookingHtml("Reservation submitted — pending resort review", guest, `<p><b>Room:</b> ${escapeHtml(record.room)}</p><p><b>Check-in:</b> ${escapeHtml(record.checkIn)}</p><p><b>Check-out:</b> ${escapeHtml(record.checkOut)}</p><p><b>Guests:</b> ${escapeHtml(record.guests || "Not specified")}</p>`) });
        },
      });
      return json(res, result.status, result.body);
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || "Could not save the reservation." });
    }
  }

  if (pathname === "/api/admin/reservation-status") {
    if (!process.env.BOOKING_ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.BOOKING_ADMIN_TOKEN)
      return json(res, 401, { error: "Unauthorized." });
    const reference = clean(data.bookingReference, 100);
    const status = clean(data.status, 40);
    if (!reference || !["confirmed", "cancelled"].includes(status))
      return json(res, 400, { error: "Provide a booking reference and status of confirmed or cancelled." });
    try {
      const record = await bookingStore.updateStatus(reference, status);
      return record ? json(res, 200, { ok: true, bookingReference: reference, status }) : json(res, 404, { error: "Reservation not found." });
    } catch (error) {
      return json(res, 500, { error: "Could not update reservation status." });
    }
  }

  if (pathname === "/api/payment-method") {
    const method = paymentMethod(data.paymentMethod);
    if (!method)
      return json(res, 400, { error: "Choose card payment or bank transfer." });
    if (method === "card")
      return json(res, 409, {
        ok: false,
        available: false,
        paymentMethod: "card",
        error: "Card payment is currently unavailable. Please proceed with bank transfer.",
        fallback: "bank-transfer",
      });
    return json(res, 200, {
      ok: true,
      available: true,
      paymentMethod: "bank-transfer",
      message: "Please complete the bank transfer, then upload your payment receipt.",
      next: "payment-proof",
    });
  }

  if (pathname === "/api/payment-proof") {
    const guest = bookingFields(data);
    if (!guest)
      return json(res, 400, {
        error: "Enter a valid guest name, email, phone number, and booking reference.",
      });
    const consentGiven =
      pathname === "/api/payment-proof" ? data.proofConsent === true : data.consent === true;
    if (!consentGiven)
      return json(res, 400, { error: "Consent is required before sending these details to the resort." });
    let savedReservation;
    try {
      savedReservation = await bookingStore.getReservation(guest.bookingReference);
    } catch (error) {
      return json(res, 500, { error: "Could not verify the reservation before processing payment proof." });
    }
    if (!savedReservation || savedReservation.email !== guest.email || savedReservation.status === "cancelled")
      return json(res, 404, { error: "An active reservation matching this guest and booking reference was not found." });
    const kind = "proof";
    if (!canSendBookingNotice(kind, req.socket.remoteAddress || "unknown", guest.email))
      return json(res, 429, { error: "Please wait before sending another notification." });
    const destination =
      process.env.BOOKING_NOTIFY_TO ||
      process.env.CONTACT_TO ||
      "reservations@calalaiyabeach-resort.com";
    const isProof = true;
    const selectedPaymentMethod = paymentMethod(data.paymentMethod);
    if (isProof && selectedPaymentMethod === "card")
      return json(res, 409, {
        error: "Card payment is currently unavailable. Please proceed with bank transfer.",
        fallback: "bank-transfer",
      });
    if (isProof && selectedPaymentMethod !== "bank-transfer")
      return json(res, 400, {
        error: "Select bank transfer before uploading your payment receipt.",
      });
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
      extraText = `\nPayment method: bank transfer\nPayment proof attached: ${fileName}`;
      extraHtml = `<p><b>Payment method:</b> bank transfer</p><p><b>Payment proof:</b> attached (${escapeHtml(fileName)})</p>`;
    }
    const title = isProof ? "Bank transfer payment proof uploaded" : "Reservation submitted";
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
      if (!(await bookingStore.markPaymentSubmitted(guest.bookingReference)))
        return json(res, 404, { error: "Reservation was not found. Please contact the resort with your booking reference." });
      return json(res, 200, {
        ok: true,
        message: isProof
          ? "Payment receipt sent to the resort. Your reservation will be reviewed by support."
          : "Reservation submitted. Choose a payment method to continue.",
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
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
    if (pathname === "/" && req.method === "GET") return sendHtml(res, SITE_HTML);
    if (pathname.startsWith("/api/")) return api(req, res, pathname);
    return json(res, 404, { error: "Not found." });
  })
  .listen(port, "0.0.0.0", () =>
    console.log(`Cala Laiya email API ready on port ${port}`),
  );
