# Resolve Ticket

<!-- slice id: resolve_ticket -->

## Model

```mermaid
eventModel
	actor Admin
	aggregate Support
	ui:Admin resolve_ui["Resolve Ticket"]
	command resolveTicket["Resolve Ticket"]
	domainEvent:Support ticketResolved["Ticket Resolved"] {
		customerId: UUID
		ticketId: UUID
		resolution: string
		resolvedAt: timestamp
	}
	slice resolve_ticket["Resolve Ticket"]
		resolve_ui-->resolveTicket
		resolveTicket-->ticketResolved
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
