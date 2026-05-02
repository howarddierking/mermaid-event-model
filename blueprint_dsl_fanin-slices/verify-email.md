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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
