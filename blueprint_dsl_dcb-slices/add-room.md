# Add Room

<!-- slice id: add_room -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Command

```mermaid
eventModel
	actor Manager
	ui:Manager room_ui["Room Management"] {
		roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	command addRoom["Add Room"] {
		roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
		reads [roomAdded] by roomNumber
	domainEvent roomAdded["Room Added"] {
		*roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	slice add_room["Add Room"]
		room_ui-->addRoom
		addRoom-->roomAdded
```

## Description

The Manager registers a new physical room in the hotel's inventory through the Room Management UI by supplying `roomNumber`, `floor`, `roomType`, and `capacity`. The `Add Room` command reads prior `Room Added` events (DCB consistency boundary) to enforce that `roomNumber` is unique across the hotel — a second attempt to add the same room number is rejected. On success the system emits a `Room Added` event carrying the four submitted fields, with `roomNumber` itself serving as the room's identity — there is no surrogate id — making the room visible to downstream slices that project room availability, cleaning schedules, and other read models.

This slice runs whenever the Manager onboards inventory — opening a new wing, adding a previously-decommissioned room back to service, or correcting an omission. The preserved invariant is **at most one room per `roomNumber`**; everything else (floor, type, capacity) is captured verbatim from the submitted form, with one exception. `roomType` may not be `Any`, compared without regard to case. The Booking Screen sends `Any` to mean rooms of any type, so a room whose type reads the same would be indistinguishable from that choice.

## Tests

```mermaid
sliceTests
	test["Add a room to empty inventory"]
		when
			command["Add Room"] {
				roomNumber: int = 101
				floor: int = 1
				roomType: string = "double"
				capacity: int = 2
			}
		then
			domainEvent["Room Added"] {
				roomNumber: int = 101
				floor: int = 1
				roomType: string = "double"
				capacity: int = 2
			}

	test["Reject duplicate room number"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
				floor: int = 1
				roomType: string = "double"
				capacity: int = 2
			}
		when
			command["Add Room"] {
				roomNumber: int = 101
				floor: int = 1
				roomType: string = "single"
				capacity: int = 1
			}
		then
			error room-already-exists["A room with that number already exists"]

	test["Adds a second room when the number differs from an existing one"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
			}
		when
			command["Add Room"] {
				roomNumber: int = 102
				floor: int = 1
				roomType: string = "double"
				capacity: int = 2
			}
		then
			domainEvent["Room Added"] {
				roomNumber: int = 102
			}

	test["Rejects a duplicate room number even on a different floor"]
		given
			domainEvent["Room Added"] {
				roomNumber: int = 101
				floor: int = 1
			}
		when
			command["Add Room"] {
				roomNumber: int = 101
				floor: int = 2
			}
		then
			error room-already-exists["A room with that number already exists"]

	test["Rejects a room type of any"]
		when
			command["Add Room"] {
				roomType: string = "any"
			}
		then
			error room-type-reserved["Any is reserved and cannot be a room type"]

	test["Rejects a room type of ANY"]
		when
			command["Add Room"] {
				roomType: string = "ANY"
			}
		then
			error room-type-reserved["Any is reserved and cannot be a room type"]
```
