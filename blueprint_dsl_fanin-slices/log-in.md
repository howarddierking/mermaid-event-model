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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
