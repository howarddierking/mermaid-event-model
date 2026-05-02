# Feed: Order Delivered

<!-- slice id: feed_order_delivered -->

## Model

```mermaid
eventModel
	aggregate Order
	domainEvent:Order orderDelivered["Order Delivered"] {
		customerId: UUID
		orderId: UUID
		deliveredAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_order_delivered["Feed: Order Delivered"]
		orderDelivered-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
