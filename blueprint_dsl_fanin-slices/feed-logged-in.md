# Feed: Logged In

<!-- slice id: feed_login -->

## Model

```mermaid
eventModel
	aggregate Auth
	domainEvent:Auth loggedIn["Logged In"] {
		customerId: UUID
		ipAddress: string
		loggedInAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_login["Feed: Logged In"]
		loggedIn-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
