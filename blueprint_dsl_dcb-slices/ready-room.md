# Ready Room

<!-- slice id: ready_room -->

## Model

```mermaid
eventModel
	actor Manager
	ui:Manager maintenance_ui["Maintenance UI"] {
		roomId: UUID
		roomNumber: int
		cleaningStatus: string
	}
	command readyRoom["Ready Room"] reads [ra, checkedOut, ready] {
		roomId: UUID
		cleanedBy: string
	}
	domainEvent ready["Room Readied"] {
		roomId: UUID
		readiedAt: timestamp
	}
	slice ready_room["Ready Room"]
		maintenance_ui-->readyRoom
		readyRoom-->ready
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
