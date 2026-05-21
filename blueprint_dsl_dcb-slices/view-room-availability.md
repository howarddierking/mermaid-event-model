# View Room Availability

<!-- slice id: view_room_availability -->

## Model

```mermaid
eventModel
	actor Guest
	domainEvent ra["Room Added"] {
		roomId: UUID
		roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	readModel avail["Room Availability"] {
		roomId: UUID
		roomNumber: int
		roomType: string
		isAvailable: boolean
		nextCheckIn: date
	}
	ui:Guest booking_ui["Booking Screen"] {
		roomId: UUID
		roomType: string
		checkIn: date
		checkOut: date
	}
	slice view_room_availability["View Room Availability"]
		ra-->avail
		avail-->booking_ui
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
