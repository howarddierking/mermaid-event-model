# Change Password

<!-- slice id: change_password -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Auth
	ui:Customer password_ui["Change Password"]
	command changePassword["Change Password"]
	domainEvent:Auth passwordChanged["Password Changed"] {
		customerId: UUID
		changedAt: timestamp
	}
	slice change_password["Change Password"]
		password_ui-->changePassword
		changePassword-->passwordChanged
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
