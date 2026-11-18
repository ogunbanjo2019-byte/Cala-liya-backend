const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Keep IDs, names, capacities and rates in sync with the frontend room catalog.
const ROOM_CATALOG = Object.freeze([
  { id: "garden-casita", name: "Garden Casita", capacity: 2, listedRatePhp: 5000 },
  { id: "garden-casita-premier", name: "Garden Casita Premier", capacity: 4, listedRatePhp: 8000 },
  { id: "two-bedroom-casita", name: "Two-Bedroom Casita", capacity: 6, listedRatePhp: 10000 },
  { id: "three-bedroom-casita", name: "Three-Bedroom Casita", capacity: 8, listedRatePhp: 13000 },
  { id: "three-bedroom-premier", name: "Three-Bedroom Premier", capacity: 9, listedRatePhp: 15500 },
  { id: "luxury-pool-villa-3br", name: "Three-Bedroom Luxury Pool Villa", capacity: 12, listedRatePhp: 19500 },
  { id: "luxury-pool-villa-4br", name: "Four-Bedroom Luxury Pool Villa", capacity: 15, listedRatePhp: 23000 },
  { id: "luxury-pool-villa-5br", name: "Five-Bedroom Luxury Pool Villa", capacity: 20, listedRatePhp: 34500 },
]);

const ROOM_BY_ID = new Map(ROOM_CATALOG.map((room) => [room.id, room]));
const ROOM_BY_NAME = new Map(ROOM_CATALOG.map((room) => [room.name.toLowerCase(), room]));

function roomIdFor(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return ROOM_BY_ID.get(key)?.id || ROOM_BY_NAME.get(key)?.id || null;
}

function resolveRoom(data) {
  const references = [data.roomId, data.room, data.roomName]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => roomIdFor(value));
  if (!references.length || references.some((id) => !id)) return null;
  if (references.some((id) => id !== references[0])) return null;
  return ROOM_BY_ID.get(references[0]) || null;
}

function validDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function availabilityFields(data) {
  const room = resolveRoom(data);
  const checkIn = String(data.checkIn || "").trim();
  const checkOut = String(data.checkOut || "").trim();
  const guests = String(data.guests ?? "").trim().slice(0, 40);
  const guestCount = /^\d+$/.test(guests) ? Number(guests) : null;
  const today = new Date().toISOString().slice(0, 10);
  if (
    !room ||
    !validDate(checkIn) ||
    !validDate(checkOut) ||
    checkIn < today ||
    checkOut <= checkIn ||
    (guestCount !== null && (guestCount < 1 || guestCount > room.capacity))
  )
    return null;
  return {
    roomId: room.id,
    room: room.name,
    roomName: room.name,
    maxGuests: room.capacity,
    listedRatePhp: room.listedRatePhp,
    checkIn,
    checkOut,
    guests,
  };
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

module.exports = { ROOM_CATALOG, roomIdFor, availabilityFields, reservationFields };
