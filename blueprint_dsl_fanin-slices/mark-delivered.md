# Mark Delivered

<!-- slice id: mark_delivered -->

## Model

```mermaid
eventModel
	actor Admin
	aggregate Order
	automation:Admin deliveryTracker["Delivery Tracker"]
	command markDelivered["Mark Delivered"]
	domainEvent:Order orderDelivered["Order Delivered"] {
		customerId: UUID
		orderId: UUID
		deliveredAt: timestamp
	}
	slice mark_delivered["Mark Delivered"]
		deliveryTracker-->markDelivered
		markDelivered-->orderDelivered
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
