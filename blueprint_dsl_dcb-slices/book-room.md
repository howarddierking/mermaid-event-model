# Book Room

<!-- slice id: book_room -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Command

```mermaid
eventModel
	actor Guest
	ui:Guest booking_ui["Booking Screen"] {
		email: string
		roomNumber: int
		roomType: string
		capacity: int
		checkIn: date
		checkOut: date
	}
	command bookRoom["Book Room"] {
		email: string
		roomNumber: int
		checkIn: date
		checkOut: date
	}
		reads [roomAdded, booked, checkedOut] by roomNumber
		reads [Registered] by email
	domainEvent booked["Room Booked"] {
		*bookingId: UUID
		*roomNumber: int
		email: string
		checkIn: date
		checkOut: date
		bookedAt: timestamp
	}
	slice book_room["Book Room"]
		booking_ui-->bookRoom
		bookRoom-->booked
```

## Description

A Guest books a specific room for a stay of `[checkIn, checkOut)`. The range is half-open: a booking of the 10th to the 12th occupies the nights of the 10th and 11th, and the checkout day is free for someone else to arrive. The Guest enters their `email` on the Booking Screen. There is no sign-in yet; once a sign-in slice exists, the email will come from the signed-in guest instead.

`Book Room` has two consistency branches. It reads the room's `Room Added`, `Room Booked` and `Checked Out` events by `roomNumber`, and the guest's `Registered` event by `email`. Both axes are named explicitly in the `reads` clauses, so nothing is derived. `Checked Out` belongs in the room branch because it carries `roomNumber` as a tag. It is matched to its booking by `bookingId`.

It refuses four requests:

- a room that was never added (`room-not-found`),
- an email that was never registered (`guest-not-registered`),
- dates where `checkOut` is not after `checkIn` (`invalid-stay-dates`), the same rule and code the Booking Screen applies to a search, so a direct call cannot book what the screen would refuse,
- a stay that overlaps an existing booking of the same room (`room-unavailable`).

A booking that has been checked out no longer blocks its room. A booking of a different room never does.

On success it emits `Room Booked`. The system assigns `bookingId` (a new unique id) and `bookedAt` (the time of booking). Neither is supplied by the caller.

## Tests

```mermaid
sliceTests
	test["Books a room and emits Room Booked for the specified room"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-12
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID = "bk-001"
				roomNumber: int = 101
				email: string = "guest@example.com"
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-12
			}

	test["Rejects booking when an existing booking overlaps the dates"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
			domainEvent["Room Booked"] {
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-14
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-08-12
				checkOut: date = 2026-08-16
			}
		then
			error room-unavailable["Room is not available for the requested dates"]

	test["Allows booking when the overlapping booking was already checked out"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
			domainEvent["Room Booked"] {
				bookingId: UUID = "bk-001"
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-14
			}
			domainEvent["Checked Out"] {
				bookingId: UUID = "bk-001"
				roomNumber: int = 101
				checkedOutAt: timestamp = 2026-08-11T09:30:00Z
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-08-12
				checkOut: date = 2026-08-16
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID = "bk-002"
				roomNumber: int = 101
				email: string = "guest@example.com"
			}

	test["Rejects a booking whose check-out is the same day as check-in"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-09-10
				checkOut: date = 2026-09-10
			}
		then
			error invalid-stay-dates["Check-out must be after check-in"]

	test["Rejects a booking whose check-out is before check-in"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-09-12
				checkOut: date = 2026-09-10
			}
		then
			error invalid-stay-dates["Check-out must be after check-in"]

	test["Rejects a booking for a room that was never added"]
		given
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-12
			}
		then
			error room-not-found["No room with that number exists"]

	test["Rejects a booking for a guest who was never registered"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-12
			}
		then
			error guest-not-registered["No guest is registered with that email"]

	test["Allows a booking that arrives on another booking's checkout day"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
			domainEvent["Room Booked"] {
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-14
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 101
				checkIn: date = 2026-08-14
				checkOut: date = 2026-08-16
			}
		then
			domainEvent["Room Booked"] {
				roomNumber: int = 101
				email: string = "guest@example.com"
				checkIn: date = 2026-08-14
				checkOut: date = 2026-08-16
			}

	test["Allows a booking of another room for overlapping dates"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
			domainEvent["Room Added"] {
				roomNumber: int = 102
			}
			domainEvent["Registered"] {
				email: string = "guest@example.com"
			}
			domainEvent["Room Booked"] {
				roomNumber: int = 101
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-14
			}
		when
			command["Book Room"] {
				email: string = "guest@example.com"
				roomNumber: int = 102
				checkIn: date = 2026-08-12
				checkOut: date = 2026-08-16
			}
		then
			domainEvent["Room Booked"] {
				roomNumber: int = 102
				email: string = "guest@example.com"
				checkIn: date = 2026-08-12
				checkOut: date = 2026-08-16
			}
```
