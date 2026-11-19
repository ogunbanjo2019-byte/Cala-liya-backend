const { availabilityFields, reservationFields } = require("../schemas/booking");
const store = require("../models/booking-store");

async function checkAvailability(data) {
  const stay = availabilityFields(data);
  if (!stay)
    return { status: 400, body: { error: "Select a valid room and enter a check-out date after check-in." } };
  const result = await store.checkAvailability(stay);
  return {
    status: 200,
    body: {
      ok: true,
      ...result,
      ...stay,
      message: result.available
        ? "Available for your selected dates. Kindly message our support if you have any question."
        : "This room is not available for your selected dates. Please choose different dates or message support.",
      next: result.available ? "guest-details" : null,
    },
  };
}

async function reserve(data, { allowNotice, notify }) {
  const reservation = reservationFields(data);
  if (!reservation)
    return { status: 400, body: { error: "Enter valid room dates and complete your name, email, and phone number." } };
  if (data.consent !== true)
    return { status: 400, body: { error: "Consent is required before sending these details to the resort." } };
  if (!allowNotice(reservation.email))
    return { status: 429, body: { error: "Please wait before submitting another reservation." } };

  const result = await store.createReservation(reservation);
  if (result.unavailable)
    return { status: 409, body: { error: "This room is no longer available for your selected dates. Please choose different dates or message support.", available: false } };

  Promise.resolve()
    .then(() => notify(result.reservation))
    .catch((error) => console.error("Reservation notification failed:", error.message));
  return {
    status: 200,
    body: {
      ok: true,
      bookingReference: result.reservation.bookingReference,
      status: result.reservation.status,
      notificationPending: true,
      message: "Reservation saved. Resort email notification is being attempted separately. Continue to payment when ready.",
      next: "payment",
    },
  };
}

module.exports = { checkAvailability, reserve };
  