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
