# Feed: Ticket Opened

<!-- slice id: feed_ticket_opened -->

## Model

```mermaid
eventModel
	aggregate Support
	domainEvent:Support ticketOpened["Ticket Opened"] {
		customerId: UUID
		ticketId: UUID
		subject: string
		openedAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_ticket_opened["Feed: Ticket Opened"]
		ticketOpened-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
