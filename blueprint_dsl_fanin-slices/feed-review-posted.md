# Feed: Review Posted

<!-- slice id: feed_review_posted -->

## Model

```mermaid
eventModel
	aggregate Support
	domainEvent:Support reviewPosted["Review Posted"] {
		customerId: UUID
		reviewId: UUID
		rating: int
		postedAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_review_posted["Feed: Review Posted"]
		reviewPosted-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
