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
