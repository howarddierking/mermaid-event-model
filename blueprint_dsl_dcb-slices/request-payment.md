# Request Payment

<!-- slice id: request_payment -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Command

```mermaid
eventModel
	actor Guest
	ui:Guest payment_ui["Payment UI"] {
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
	}
	command pay["Pay"] reads [booked, paymentRequested, paymentSucceeded] {
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
	}
	domainEvent paymentRequested["Payment Requested"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		requestedAt: timestamp
	}
	slice request_payment["Request Payment"]
		payment_ui-->pay
		pay-->paymentRequested
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
