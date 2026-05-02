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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
