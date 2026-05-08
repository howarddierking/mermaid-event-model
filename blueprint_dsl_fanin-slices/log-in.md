# Log In

<!-- slice id: log_in -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Auth
	ui:Customer login_ui["Log In"]
	command logIn["Log In"]
	domainEvent:Auth loggedIn["Logged In"] {
		customerId: UUID
		ipAddress: string
		loggedInAt: timestamp
	}
	slice log_in["Log In"]
		login_ui-->logIn
		logIn-->loggedIn
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
