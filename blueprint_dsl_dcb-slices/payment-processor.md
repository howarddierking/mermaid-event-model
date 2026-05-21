# Payment Processor

<!-- slice id: payment_processor -->

## Model

```mermaid
eventModel
	actor Guest
	domainEvent paymentRequested["Payment Requested"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		requestedAt: timestamp
	}
	readModel paymentsToProcess["Payments to Process"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		status: string
	}
	automation:Guest paymentProcessor["Payment Processor"]
	externalEvent gatewayConfirmed["Gateway Confirmed"] {
		paymentId: UUID
		transactionRef: string
		confirmedAt: timestamp
	}
	command processPayment["Process Payment"] reads [paymentRequested, paymentSucceeded] {
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
	slice payment_processor["Payment Processor"]
		paymentRequested-->paymentsToProcess
		paymentSucceeded-->paymentsToProcess
		paymentsToProcess-->paymentProcessor
		paymentProcessor-->processPayment
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
			# models, signals to external systems.
```
