# Register

<!-- slice id: register -->

## Model

```mermaid
eventModel
	actor Guest
	ui:Guest reg_ui["Registration UI"] {
		name: string
		email: string
		password: string
	}
	command Register reads [Registered] {
		name: string
		email: string
		password: string
	}
	domainEvent Registered {
		guestId: UUID
		name: string
		email: string
		registeredAt: timestamp
	}
	slice register["Register"]
		reg_ui-->Register
		Register-->Registered
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
