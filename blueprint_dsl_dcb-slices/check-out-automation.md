# Check-out Automation

<!-- slice id: check_out_automation -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Automation

```mermaid
eventModel
	actor System
	readModel guestRoster["Guest Roster"] {
		*email: string
		guestName: string
		roomNumber: int
		checkedInAt: timestamp
		isPresent: boolean
	}
	automation:System checkOutAutomation["Check-out Automation"]
	command checkOut["Checked Out"] {
		bookingId: UUID
	}
		reads [checkedIn, checkedOut] by bookingId
	domainEvent checkedOut["Checked Out"] {
		*bookingId: UUID
		*roomNumber: int
		*email: string
		checkedOutAt: timestamp
	}
	slice check_out_automation["Check-out Automation"]
		guestRoster-->checkOutAutomation
		checkOutAutomation-->checkOut
		checkOut-->checkedOut
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
