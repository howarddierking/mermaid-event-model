# Open Ticket

<!-- slice id: open_ticket -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Support
	ui:Customer ticket_ui["Open Ticket"]
	command openTicket["Open Ticket"]
	domainEvent:Support ticketOpened["Ticket Opened"] {
		customerId: UUID
		ticketId: UUID
		subject: string
		openedAt: timestamp
	}
	slice open_ticket["Open Ticket"]
		ticket_ui-->openTicket
		openTicket-->ticketOpened
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
