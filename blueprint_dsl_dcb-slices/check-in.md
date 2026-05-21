# Check-in

<!-- slice id: check_in -->

## Model

```mermaid
eventModel
	actor Guest
	ui:Guest checkin_ui["Check-in Screen"] {
		bookingId: UUID
		guestName: string
		roomNumber: int
	}
	command checkin["Check-in"] reads [booked, checkedIn] {
		bookingId: UUID
		guestId: UUID
	}
	domainEvent checkedIn["Checked In"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkedInAt: timestamp
	}
	slice check_in["Check-in"]
		checkin_ui-->checkin
		checkin-->checkedIn
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
