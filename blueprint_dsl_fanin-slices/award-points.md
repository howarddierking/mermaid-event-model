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
