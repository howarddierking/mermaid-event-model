# Process Payment

<!-- slice id: process_payment -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Payment
	automation:Customer paymentRunner["Payment Runner"]
	command processPayment["Process Payment"]
	domainEvent:Payment paymentProcessed["Payment Processed"] {
		customerId: UUID
		paymentId: UUID
		amount: decimal
		processedAt: timestamp
	}
	slice process_payment["Process Payment"]
		paymentRunner-->processPayment
		processPayment-->paymentProcessed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
