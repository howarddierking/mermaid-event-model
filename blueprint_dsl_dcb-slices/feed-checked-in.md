# Feed: Checked In

<!-- slice id: feed_checked_in -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** View

```mermaid
eventModel
	domainEvent checkedIn["Checked In"] {
		*bookingId: UUID
		*email: string
		roomId: UUID
		checkedInAt: timestamp
	}
	readModel guestRoster["Guest Roster"] {
		*email: string
		guestName: string
		roomNumber: int
		checkedInAt: timestamp
		isPresent: boolean
	}
	slice feed_checked_in["Feed: Checked In"]
		checkedIn-->guestRoster
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
