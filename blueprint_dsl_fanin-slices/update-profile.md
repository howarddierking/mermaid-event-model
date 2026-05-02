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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
