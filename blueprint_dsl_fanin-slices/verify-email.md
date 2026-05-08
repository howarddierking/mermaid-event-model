# Verify Email

<!-- slice id: verify_email -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Auth
	automation:Customer emailVerifier["Email Verifier"]
	command verifyEmail["Verify Email"]
	domainEvent:Auth emailVerified["Email Verified"] {
		customerId: UUID
		email: string
		verifiedAt: timestamp
	}
	slice verify_email["Verify Email"]
		emailVerifier-->verifyEmail
		verifyEmail-->emailVerified
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
