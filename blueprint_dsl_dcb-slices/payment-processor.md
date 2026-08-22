# Payment Processor

<!-- slice id: payment_processor -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Automation

```mermaid
eventModel
	actor Guest
	readModel paymentsToProcess["Payments to Process"] {
		*paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		status: string
	}
	automation:Guest paymentProcessor["Payment Processor"]
	command submitPayment["Submit Payment"] {
		paymentId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
	}
		reads [paymentRequested, paymentSubmitted] by paymentId
	domainEvent paymentSubmitted["Payment Submitted"] {
		*paymentId: UUID
		bookingId: UUID
		amount: decimal
		submittedAt: timestamp
	}
	slice payment_processor["Payment Processor"]
		paymentsToProcess-->paymentProcessor
		paymentProcessor-->submitPayment
		submitPayment-->paymentSubmitted
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
