# Place Order

<!-- slice id: place_order -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Order
	ui:Customer order_ui["Place Order"]
	command placeOrder["Place Order"]
	domainEvent:Order orderPlaced["Order Placed"] {
		customerId: UUID
		orderId: UUID
		total: decimal
		placedAt: timestamp
	}
	slice place_order["Place Order"]
		order_ui-->placeOrder
		placeOrder-->orderPlaced
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
