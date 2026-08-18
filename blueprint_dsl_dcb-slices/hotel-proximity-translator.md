# Hotel Proximity Translator

<!-- slice id: hotel_proximity_translator -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Translation `[abbreviated]`

```mermaid
eventModel
	externalEvent positionUpdated["Position Updated"] {
		guestId: UUID
		latitude: float
		longitude: float
		timestamp: timestamp
	}
	command hotelProximityTranslator["Hotel Proximity Translator"] reads [checkedIn, checkedOut]
	domainEvent guestLeft["Guest Left Hotel"] {
		guestId: UUID
		departedAt: timestamp
	}
	slice hotel_proximity_translator["Hotel Proximity Translator"]
		positionUpdated-->hotelProximityTranslator
		hotelProximityTranslator-->guestLeft
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
