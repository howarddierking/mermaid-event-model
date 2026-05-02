# Sign Up

<!-- slice id: sign_up -->

## Model

```mermaid
eventModel
	actor Customer
	aggregate Auth
	ui:Customer signup_ui["Sign Up"]
	command signUp["Sign Up"]
	domainEvent:Auth signedUp["Signed Up"] {
		customerId: UUID
		email: string
		signedUpAt: timestamp
	}
	slice sign_up["Sign Up"]
		signup_ui-->signUp
		signUp-->signedUp
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
