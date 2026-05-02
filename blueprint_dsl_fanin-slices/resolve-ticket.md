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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
