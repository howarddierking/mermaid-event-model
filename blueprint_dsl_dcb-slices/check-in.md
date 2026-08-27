# Check-in

<!-- slice id: check_in -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Command

```mermaid
eventModel
	actor Guest
	ui:Guest checkin_ui["Check-in Screen"] {
		bookingId: UUID
		guestName: string
		roomNumber: int
	}
	command checkin["Check-in"] {
		bookingId: UUID
	}
		reads [booked, checkedIn] by bookingId
	domainEvent checkedIn["Checked In"] {
		*bookingId: UUID
		*email: string
		roomNumber: int
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
