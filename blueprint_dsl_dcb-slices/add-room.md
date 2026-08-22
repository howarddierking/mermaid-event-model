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
		reads [ra] by roomNumber
	domainEvent ra["Room Added"] {
		*roomId: UUID
		*roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	slice add_room["Add Room"]
		room_ui-->addRoom
		addRoom-->ra
```

## Description

The Manager registers a new physical room in the hotel's inventory through the Room Management UI by supplying `roomNumber`, `floor`, `roomType`, and `capacity`. The `Add Room` command reads prior `Room Added` events (DCB consistency boundary) to enforce that `roomNumber` is unique across the hotel — a second attempt to add the same room number is rejected. On success the system emits a `Room Added` event carrying a server-assigned `roomId` (UUID) plus the four submitted fields, making the room visible to downstream slices that project room availability, cleaning schedules, and other read models.

This slice runs whenever the Manager onboards inventory — opening a new wing, adding a previously-decommissioned room back to service, or correcting an omission. The preserved invariant is **at most one room per `roomNumber`**; everything else (floor, type, capacity) is captured verbatim from the submitted form.

## Tests

```mermaid
sliceTests
	test["Add a room to empty inventory"]
		when
			command["Add Room"] {
				roomNumber: int
				floor: int
				roomType: string
				capacity: int
			}
		then
			domainEvent["Room Added"] {
				roomId: UUID
				roomNumber: int
				floor: int
				roomType: string
				capacity: int
			}

	test["Reject duplicate room number"]
		given
			domainEvent["Room Added"] {
				roomId: UUID
				roomNumber: int
				floor: int
				roomType: string
				capacity: int
			}
		when
			command["Add Room"] {
				roomNumber: int
				floor: int
				roomType: string
				capacity: int
			}
		then
			error["Room with roomNumber already exists"]
```
