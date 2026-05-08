# Process Payment

<!-- slice id: process_payment -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Payment
	automation:Customer paymentRunner["Payment Runner"]
	command processPayment["Process Payment"]
	domainEvent:Payment paymentProcessed["Payment Processed"] {
		customerId: UUID
		paymentId: UUID
		amount: decimal
		processedAt: timestamp
	}
	slice process_payment["Process Payment"]
		paymentRunner-->processPayment
		processPayment-->paymentProcessed
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
