const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const dataFile = path.resolve(
  process.env.BOOKING_DATA_FILE || path.join(process.cwd(), "data", "reservations.json"),
);
const blockingStatuses = new Set(["pending", "confirmed", "payment-submitted"]);
let queue = Promise.resolve();

function inventory() {
  let parsed;
  try {
    parsed = JSON.parse(process.env.ROOM_INVENTORY_JSON || "{}");
  } catch {
    throw Object.assign(new Error("Room inventory is not configured correctly."), { status: 503 });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw Object.assign(new Error("Room inventory is not configured correctly."), { status: 503 });
  }
  const result = {};
  for (const [room, count] of Object.entries(parsed)) {
    if (typeof room === "string" && room.trim() && Number.isSafeInteger(count) && count > 0)
      result[room.trim()] = count;
  }
  if (!Object.keys(result).length)
    throw Object.assign(new Error("Room inventory is not configured yet. Please contact the resort."), { status: 503 });
  return result;
}

async function readBookings() {
  try {
    const records = JSON.parse(await fs.readFile(dataFile, "utf8"));
    if (!Array.isArray(records)) throw new Error("Invalid reservation store format.");
    return records;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeBookings(records) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const temporary = `${dataFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, dataFile);
}

function serialized(operation) {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}

function overlaps(a, b) {
  return a.checkIn < b.checkOut && b.checkIn < a.checkOut;
}

function availabilityFor(records, stay) {
  const inventoryByRoom = inventory();
  const capacity = inventoryByRoom[stay.room];
  if (!capacity) return { available: false, room: stay.room, remaining: 0 };
  const occupied = records.filter(
    (record) => record.room === stay.room && blockingStatuses.has(record.status) && overlaps(record, stay),
  ).length;
  return { available: occupied < capacity, room: stay.room, remaining: Math.max(0, capacity - occupied) };
}

async function checkAvailability(stay) {
  return serialized(async () => availabilityFor(await readBookings(), stay));
}

async function createReservation(input) {
  return serialized(async () => {
    const records = await readBookings();
    const existing = records.find((record) => record.bookingReference === input.bookingReference);
    if (existing) return { created: false, reservation: existing };
    const availability = availabilityFor(records, input);
    if (!availability.available)
      return { created: false, unavailable: true, remaining: availability.remaining };
    const reservation = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paymentMethod: null,
      paymentSubmittedAt: null,
    };
    records.push(reservation);
    await writeBookings(records);
    return { created: true, reservation };
  });
}

async function getReservation(bookingReference) {
  return serialized(async () => {
    const records = await readBookings();
    return records.find((record) => record.bookingReference === bookingReference) || null;
  });
}

async function markPaymentSubmitted(bookingReference) {
  return serialized(async () => {
    const records = await readBookings();
    const record = records.find((item) => item.bookingReference === bookingReference);
    if (!record || record.status === "cancelled") return false;
    record.status = "payment-submitted";
    record.paymentMethod = "bank-transfer";
    record.paymentSubmittedAt = new Date().toISOString();
    record.updatedAt = record.paymentSubmittedAt;
    await writeBookings(records);
    return true;
  });
}

async function updateStatus(bookingReference, status) {
  return serialized(async () => {
    const records = await readBookings();
    const record = records.find((item) => item.bookingReference === bookingReference);
    if (!record) return null;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    await writeBookings(records);
    return record;
  });
}

module.exports = { checkAvailability, createReservation, getReservation, markPaymentSubmitted, updateStatus };
