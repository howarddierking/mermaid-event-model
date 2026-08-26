# Roll Availability

<!-- slice id: roll_availability -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Automation

```mermaid
eventModel
	actor System
	readModel horizon["Availability Horizon"] {
		*roomNumber: int
		roomType: string
		capacity: int
		seededThrough: date
		requiredThrough: date
	}
	automation:System availabilityMaintainer["Availability Maintainer"]
	command rollAvailability["Roll Availability"] {
		roomNumber: int
		roomType: string
		capacity: int
		fromNight: date
		throughNight: date
	}
		reads [availabilityRolled] by roomNumber
	domainEvent availabilityRolled["Availability Rolled"] {
		*roomNumber: int
		roomType: string
		capacity: int
		fromNight: date
		throughNight: date
		rolledAt: timestamp
	}
	slice roll_availability["Roll Availability"]
		horizon-->availabilityMaintainer
		availabilityMaintainer-->rollAvailability
		rollAvailability-->availabilityRolled
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
			# models, signals to external systems. For rejection
			# scenarios use `error["<message>"]` — the message is
			# read verbatim by code generation.
	# Data-section fields may carry example values to demonstrate the
	# case and seed code-gen fixtures, e.g. { checkIn: date = 2026-08-12 }.
```
