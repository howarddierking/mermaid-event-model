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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
