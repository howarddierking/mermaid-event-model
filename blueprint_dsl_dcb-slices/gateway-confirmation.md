# Gateway Confirmation

<!-- slice id: gateway_confirmation -->

## Model

```mermaid
eventModel
	externalEvent gatewayConfirmed["Gateway Confirmed"] {
		paymentId: UUID
		transactionRef: string
		confirmedAt: timestamp
	}
	command processPayment["Process Payment"] reads [paymentSubmitted, paymentSucceeded] {
		paymentId: UUID
		gatewayRef: string
	}
	domainEvent paymentSucceeded["Payment Succeeded"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		transactionRef: string
		succeededAt: timestamp
	}
	slice gateway_confirmation["Gateway Confirmation"]
		gatewayConfirmed-->processPayment
		processPayment-->paymentSucceeded
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
