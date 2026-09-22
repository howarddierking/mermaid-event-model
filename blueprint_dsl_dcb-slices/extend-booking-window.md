# Extend Booking Window

<!-- slice id: extend_booking_window -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Translation `[abbreviated]`

```mermaid
eventModel
	externalEvent weekElapsed["Week Elapsed"] {
		occurredAt: date
	}
	command extendBookingWindow["Extend Booking Window"] {
		weekOf: date
	}
		reads [bookingWindowExtended] by weekOf
	domainEvent bookingWindowExtended["Booking Window Extended"] {
		*weekOf: date
		requiredThrough: date
	}
	slice extend_booking_window["Extend Booking Window"]
		weekElapsed-->extendBookingWindow
		extendBookingWindow-->bookingWindowExtended
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
