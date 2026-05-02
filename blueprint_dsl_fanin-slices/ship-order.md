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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
