# Check-out Automation

<!-- slice id: check_out_automation -->

## Model

```mermaid
eventModel
	actor Manager
	domainEvent checkedIn["Checked In"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkedInAt: timestamp
	}
	readModel guestRoster["Guest Roster"] {
		guestId: UUID
		guestName: string
		roomNumber: int
		checkedInAt: timestamp
		isPresent: boolean
	}
	domainEvent guestLeft["Guest Left Hotel"] {
		guestId: UUID
		departedAt: timestamp
	}
	automation:Manager checkOutAutomation["Check-out Automation"]
	command checkOut["Checked Out"] reads [checkedIn, checkedOut] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
	}
	domainEvent checkedOut["Checked Out"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkedOutAt: timestamp
	}
	slice check_out_automation["Check-out Automation"]
		checkedIn-->guestRoster
		guestLeft-->guestRoster
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
