# View Room Availability

<!-- slice id: view_room_availability -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** View

```mermaid
eventModel
	actor Guest
	domainEvent roomAdded["Room Added"] {
		*roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	readModel avail["Room Availability"] {
		*roomNumber: int
		roomType: string
		isAvailable: boolean
		nextCheckIn: date
	}
	ui:Guest booking_ui["Booking Screen"] {
		roomNumber: int
		roomType: string
		checkIn: date
		checkOut: date
	}
	slice view_room_availability["View Room Availability"]
		roomAdded-->avail
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
