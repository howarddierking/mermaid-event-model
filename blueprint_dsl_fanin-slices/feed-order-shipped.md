# Feed: Order Shipped

<!-- slice id: feed_order_shipped -->

## Model

```mermaid
eventModel
	aggregate Order
	domainEvent:Order orderShipped["Order Shipped"] {
		customerId: UUID
		orderId: UUID
		carrier: string
		shippedAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_order_shipped["Feed: Order Shipped"]
		orderShipped-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
