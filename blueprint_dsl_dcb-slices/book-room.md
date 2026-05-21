# Book Room

<!-- slice id: book_room -->

## Model

```mermaid
eventModel
	actor Guest
	ui:Guest booking_ui["Booking Screen"] {
		roomId: UUID
		roomType: string
		checkIn: date
		checkOut: date
	}
	command bookRoom["Book Room"] reads [Registered, ra, booked] {
		guestId: UUID
		roomId: UUID
		checkIn: date
		checkOut: date
	}
	domainEvent booked["Room Booked"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkIn: date
		checkOut: date
		bookedAt: timestamp
	}
	slice book_room["Book Room"]
		booking_ui-->bookRoom
		bookRoom-->booked
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```mermaid
sliceTests
	test["Describe what this test verifies"]
		given
			# Preconditions: events that have already occurred,
			# read models that must be present.
		when
			# The command (or signal) under test. Omit `when`
			# for state-view tests that only project a read model.
		then
			# Expected outcomes: emitted events, populated read
			# models, signals to external systems.
```
