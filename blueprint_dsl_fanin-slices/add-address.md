# Add Address

<!-- slice id: add_address -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Profile
	ui:Customer address_ui["Add Address"]
	command addAddress["Add Address"]
	domainEvent:Profile addressAdded["Address Added"] {
		customerId: UUID
		addressId: UUID
		addressType: string
		addedAt: timestamp
	}
	slice add_address["Add Address"]
		address_ui-->addAddress
		addAddress-->addressAdded
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
