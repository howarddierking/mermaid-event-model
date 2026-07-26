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
	command bookRoom["Book Room"] reads [Registered, ra, booked, checkedOut] {
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
	test["Books a room and emits Room Booked for the specified room"]
		when
			command["Book Room"] {
				roomId: UUID = "room-101"
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID = "bk-001"
				roomId: UUID = "room-101"
			}

	test["Rejects booking when an existing booking overlaps the dates"]
		given
			domainEvent["Room Booked"] {
				roomId: UUID = "room-101"
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-14
			}
		when
			command["Book Room"] {
				roomId: UUID = "room-101"
				checkIn: date = 2026-08-12
				checkOut: date = 2026-08-16
			}
		then
			error["Room is not available for the requested dates"]

	test["Allows booking when the overlapping booking was already checked out"]
		given
			domainEvent["Room Booked"] {
				bookingId: UUID = "bk-001"
				roomId: UUID = "room-101"
				checkIn: date = 2026-08-10
				checkOut: date = 2026-08-14
			}
			domainEvent["Checked Out"] {
				bookingId: UUID = "bk-001"
				roomId: UUID = "room-101"
				checkedOutAt: timestamp = 2026-08-11T09:30:00Z
			}
		when
			command["Book Room"] {
				roomId: UUID = "room-101"
				checkIn: date = 2026-08-12
				checkOut: date = 2026-08-16
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID = "bk-002"
				roomId: UUID = "room-101"
			}
```
