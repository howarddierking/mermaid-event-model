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
				roomId: UUID
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID
				roomId: UUID
			}

	test["Rejects booking when an existing booking overlaps the dates"]
		given
			domainEvent["Room Booked"] {
				roomId: UUID
				checkIn: date
				checkOut: date
			}
		when
			command["Book Room"] {
				roomId: UUID
				checkIn: date
				checkOut: date
			}
		then
			error["Room is not available for the requested dates"]

	test["Allows booking when the overlapping booking was already checked out"]
		given
			domainEvent["Room Booked"] {
				bookingId: UUID
				roomId: UUID
				checkIn: date
				checkOut: date
			}
			domainEvent["Checked Out"] {
				bookingId: UUID
				roomId: UUID
				checkedOutAt: timestamp
			}
		when
			command["Book Room"] {
				roomId: UUID
				checkIn: date
				checkOut: date
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID
				roomId: UUID
			}
```
