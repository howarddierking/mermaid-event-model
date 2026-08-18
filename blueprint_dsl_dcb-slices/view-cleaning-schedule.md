# View Cleaning Schedule

<!-- slice id: view_cleaning_schedule -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** View

```mermaid
eventModel
	actor Manager
	domainEvent booked["Room Booked"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkIn: date
		checkOut: date
		bookedAt: timestamp
	}
	readModel cleaning_schedule["Cleaning Schedule"] {
		roomId: UUID
		roomNumber: int
		guestCheckOut: date
		cleaningStatus: string
	}
	ui:Manager maintenance_ui["Maintenance UI"] {
		roomId: UUID
		roomNumber: int
		cleaningStatus: string
	}
	slice view_cleaning_schedule["View Cleaning Schedule"]
		booked-->cleaning_schedule
		cleaning_schedule-->maintenance_ui
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
