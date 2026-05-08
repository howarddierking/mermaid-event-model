# Update Profile

<!-- slice id: update_profile -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Profile
	ui:Customer profile_ui["Edit Profile"]
	command updateProfile["Update Profile"]
	domainEvent:Profile profileUpdated["Profile Updated"] {
		customerId: UUID
		fieldsChanged: string
		updatedAt: timestamp
	}
	slice update_profile["Update Profile"]
		profile_ui-->updateProfile
		updateProfile-->profileUpdated
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
