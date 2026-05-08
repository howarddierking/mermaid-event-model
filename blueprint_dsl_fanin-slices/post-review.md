# Post Review

<!-- slice id: post_review -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Support
	ui:Customer review_ui["Write Review"]
	command postReview["Post Review"]
	domainEvent:Support reviewPosted["Review Posted"] {
		customerId: UUID
		reviewId: UUID
		rating: int
		postedAt: timestamp
	}
	slice post_review["Post Review"]
		review_ui-->postReview
		postReview-->reviewPosted
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
