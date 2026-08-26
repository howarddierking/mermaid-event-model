# View Room Availability

<!-- slice id: view_room_availability -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** View

```mermaid
eventModel
	actor Guest
	readModel avail["Room Availability"] {
		*roomNumber: int
		*night: date
		roomType: string
		capacity: int
		isAvailable: boolean
	}
	domainEvent availabilityRolled["Availability Rolled"] {
		*roomNumber: int
		roomType: string
		capacity: int
		fromNight: date
		throughNight: date
		rolledAt: timestamp
	}
	ui:Guest booking_ui["Booking Screen"] {
		roomNumber: int
		roomType: string
		capacity: int
		checkIn: date
		checkOut: date
	}
	domainEvent booked["Room Booked"] {
		*bookingId: UUID
		*roomNumber: int
		email: string
		checkIn: date
		checkOut: date
		bookedAt: timestamp
	}
	slice view_room_availability["View Room Availability"]
		availabilityRolled-->avail
		booked-->avail
		avail-->booking_ui
```

## Description

A prospective Guest searches for a room to stay in, giving the criteria that matter to them: the stay dates (`checkIn`/`checkOut`), the `roomType` they want, and the `capacity` they need. The Booking Screen answers with the rooms that satisfy all of it. When nothing satisfies it — including when the requested dates fall outside the window the system has seeded — the screen tells them no rooms are available rather than showing a partial or misleading list.

`Room Availability` is keyed by **(`roomNumber`, `night`)**: one row per room per night, carrying that room's `roomType` and `capacity` alongside `isAvailable`. Availability is a property of a room *on a night*, not of a room, which is why the row is grained this way and why `isAvailable` is meaningful at all. Two events maintain it. `Availability Rolled` seeds the nights for a room across the booking window and trims nights that have fallen into the past; `Room Booked` flips the nights a booking occupies to unavailable. A booking of 10th→12th occupies the nights of the 10th and 11th — **the checkout day is free**, and someone else may arrive that day.

The query rule is the part most easily implemented backwards, so state it plainly:

> A room qualifies when the count of its `isAvailable` rows in `[checkIn, checkOut)` **equals the number of nights requested**.

Written the obvious way instead — "no unavailable row exists for those nights" — a search for dates the system has no rows for at all matches *every* room rather than none. That single inversion is what makes the horizon enforceable here: rows exist only from today through the six-month booking horizon, so a stay in the past or beyond the horizon simply has no rows to count, falls short of the requested night count, and matches nothing. A stay that *straddles* the horizon edge fails the same way, with no special case. No command validates the horizon — `Book Room` will accept a far-future `checkIn` if called directly — so this is an affordance of the app, not an invariant of the event store.

## Tests

```mermaid
sliceTests
	test["Offers a room when every requested night is available"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				roomType: string = "double"
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				roomType: string = "double"
				capacity: int = 2
				checkIn: date = 2026-09-10
				checkOut: date = 2026-09-12
			}
		then
			readModel["Room Availability"] {
				roomNumber: int = 101
				night: date = 2026-09-10
				isAvailable: boolean = true
			}
			readModel["Room Availability"] {
				roomNumber: int = 101
				night: date = 2026-09-11
				isAvailable: boolean = true
			}

	test["Excludes a room when a booking occupies one of the requested nights"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
			domainEvent["Room Booked"] {
				roomNumber: int = 101
				checkIn: date = 2026-09-10
				checkOut: date = 2026-09-12
			}
		when
			ui["Booking Screen"] {
				capacity: int = 2
				checkIn: date = 2026-09-11
				checkOut: date = 2026-09-13
			}
		then
			none["No rooms match the requested dates"]

	test["Offers a room from the day an existing booking checks out"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
			domainEvent["Room Booked"] {
				roomNumber: int = 101
				checkIn: date = 2026-09-10
				checkOut: date = 2026-09-12
			}
		when
			ui["Booking Screen"] {
				capacity: int = 2
				checkIn: date = 2026-09-12
				checkOut: date = 2026-09-14
			}
		then
			readModel["Room Availability"] {
				roomNumber: int = 101
				night: date = 2026-09-12
				isAvailable: boolean = true
			}
			readModel["Room Availability"] {
				roomNumber: int = 101
				night: date = 2026-09-13
				isAvailable: boolean = true
			}

	test["Offers nothing when the whole stay runs past the seeded horizon"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				capacity: int = 2
				checkIn: date = 2027-03-01
				checkOut: date = 2027-03-04
			}
		then
			none["No rooms match the requested dates"]

	test["Offers nothing when only part of the stay runs past the horizon"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				capacity: int = 2
				checkIn: date = 2027-02-20
				checkOut: date = 2027-02-24
			}
		then
			none["No rooms match the requested dates"]

	test["Offers nothing for dates that have already passed"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				capacity: int = 2
				checkIn: date = 2026-08-20
				checkOut: date = 2026-08-22
			}
		then
			none["No rooms match the requested dates"]

	test["Excludes a room that cannot seat the party"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				roomType: string = "double"
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				capacity: int = 4
				checkIn: date = 2026-09-10
				checkOut: date = 2026-09-12
			}
		then
			none["No rooms match the requested criteria"]

	test["Excludes a room of a different type"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				roomType: string = "double"
				capacity: int = 2
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				roomType: string = "suite"
				capacity: int = 2
				checkIn: date = 2026-09-10
				checkOut: date = 2026-09-12
			}
		then
			none["No rooms match the requested criteria"]
```
