# Ship Order

<!-- slice id: ship_order -->

## Model

```mermaid
eventModel
	actor Admin
	aggregate Order
	ui:Admin ship_ui["Ship Order"]
	command shipOrder["Ship Order"]
	domainEvent:Order orderShipped["Order Shipped"] {
		customerId: UUID
		orderId: UUID
		carrier: string
		shippedAt: timestamp
	}
	slice ship_order["Ship Order"]
		ship_ui-->shipOrder
		shipOrder-->orderShipped
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
