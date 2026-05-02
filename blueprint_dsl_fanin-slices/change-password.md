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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
