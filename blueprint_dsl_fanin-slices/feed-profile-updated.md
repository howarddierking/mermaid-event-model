# Feed: Profile Updated

<!-- slice id: feed_profile_updated -->

## Model

```mermaid
eventModel
	aggregate Profile
	domainEvent:Profile profileUpdated["Profile Updated"] {
		customerId: UUID
		fieldsChanged: string
		updatedAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_profile_updated["Feed: Profile Updated"]
		profileUpdated-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
