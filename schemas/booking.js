const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOMS = new Set(["Seaview Suite", "Garden Villa", "Beachfront Cottage"]);

function validDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function availabilityFields(data) {
  const room = String(data.room || data.roomName || "").trim().slice(0, 160);
  const checkIn = String(data.checkIn || "").trim();
  const checkOut = String(data.checkOut || "").trim();
  const guests = String(data.guests || "").trim().slice(0, 40);
  const today = new Date().toISOString().slice(0, 10);
  if (!ROOMS.has(room) || !validDate(checkIn) || !validDate(checkOut) || checkIn < today || checkOut <= checkIn)
    return null;
  return { room, checkIn, checkOut, guests };
}

function reservationFields(data) {
  const stay = availabilityFields(data);
  const name = String(data.name || "").trim().slice(0, 120);
  const email = String(data.email || "").trim().toLowerCase().slice(0, 254);
  const phone = String(data.phone || "").trim().slice(0, 80);
  const bookingReference = String(data.bookingReference || "").trim().slice(0, 100);
  if (!stay || !name || !EMAIL_RE.test(email) || !phone || !/^CL-[A-Z0-9-]{6,40}$/i.test(bookingReference))
    return null;
  return { ...stay, name, email, phone, bookingReference };
}

module.exports = { availabilityFields, reservationFields };
