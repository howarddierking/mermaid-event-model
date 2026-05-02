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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
