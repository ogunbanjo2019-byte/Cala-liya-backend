const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOM_CATALOG, roomIdFor } = require("../schemas/booking");

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
  const expectedIds = new Set(ROOM_CATALOG.map((room) => room.id));
  if (Object.keys(parsed).some((roomId) => !expectedIds.has(roomId))) {
    throw Object.assign(new Error("Room inventory contains an unknown room ID. Use the IDs from the Cala Laiya frontend catalog."), { status: 503 });
  }
  const result = {};
  for (const room of ROOM_CATALOG) {
    const count = parsed[room.id];
    if (!Number.isSafeInteger(count) || count < 1) {
      throw Object.assign(new Error(`Room inventory needs a positive unit count for ${room.name} (${room.id}).`), { status: 503 });
    }
    result[room.id] = count;
  }
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
  const roomId = stay.roomId || roomIdFor(stay.room);
  const capacity = inventoryByRoom[roomId];
  if (!capacity)
    throw Object.assign(new Error(`Inventory is not configured for ${stay.room || roomId}.`), { status: 503 });

  const activeRecords = records.filter((record) => blockingStatuses.has(record.status));
  const resolvedRecords = activeRecords.map((record) => {
    const existingRoomId = roomIdFor(record.roomId) || roomIdFor(record.roomName) || roomIdFor(record.room);
    if (!existingRoomId)
      throw Object.assign(new Error("An existing reservation uses an unmapped room name. Map legacy reservations before enabling availability checks."), { status: 503 });
    return { record, roomId: existingRoomId };
  });
  const occupied = resolvedRecords.filter(
    ({ record, roomId: existingRoomId }) => existingRoomId === roomId && overlaps(record, stay),
  ).length;
  return {
    available: occupied < capacity,
    roomId,
    room: stay.room,
    remaining: Math.max(0, capacity - occupied),
  };
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
