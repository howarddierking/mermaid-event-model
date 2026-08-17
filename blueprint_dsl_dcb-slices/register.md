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
	test["Registers a new guest and records their name and email"]
		when
			command["Register"] {
				name: string = "Ada Lovelace"
				email: string = "ada@example.com"
			}
		then
			domainEvent["Registered"] {
				name: string = "Ada Lovelace"
				email: string = "ada@example.com"
			}

	test["Rejects a registration whose email is already registered"]
		given
			domainEvent["Registered"] {
				email: string = "ada@example.com"
			}
		when
			command["Register"] {
				email: string = "ada@example.com"
			}
		then
			error["A guest cannot be registered more than once"]
```
