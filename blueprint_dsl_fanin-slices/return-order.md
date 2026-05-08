# Return Order

<!-- slice id: return_order -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Order
	ui:Customer return_ui["Return Order"]
	command returnOrder["Return Order"]
	domainEvent:Order orderReturned["Order Returned"] {
		customerId: UUID
		orderId: UUID
		reason: string
		returnedAt: timestamp
	}
	slice return_order["Return Order"]
		return_ui-->returnOrder
		returnOrder-->orderReturned
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
