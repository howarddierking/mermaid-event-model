# Award Points

<!-- slice id: award_points -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Loyalty
	automation:Customer loyaltyEngine["Loyalty Engine"]
	command awardPoints["Award Points"]
	domainEvent:Loyalty pointsEarned["Points Earned"] {
		customerId: UUID
		points: int
		reason: string
		earnedAt: timestamp
	}
	slice award_points["Award Points"]
		loyaltyEngine-->awardPoints
		awardPoints-->pointsEarned
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
