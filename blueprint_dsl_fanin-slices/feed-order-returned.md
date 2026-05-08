# Feed: Order Returned

<!-- slice id: feed_order_returned -->

## Model

```mermaid
eventModel
	aggregate Order
	domainEvent:Order orderReturned["Order Returned"] {
		customerId: UUID
		orderId: UUID
		reason: string
		returnedAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_order_returned["Feed: Order Returned"]
		orderReturned-->activityFeed
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
