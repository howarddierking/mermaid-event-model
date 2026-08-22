# Register

<!-- slice id: register -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** Command

```mermaid
eventModel
	actor Guest
	ui:Guest reg_ui["Registration UI"] {
		name: string
		email: string
		password: string
	}
	command Register {
		name: string
		email: string
		password: string
	}
		reads [Registered] by email
	domainEvent Registered {
		*email: string
		name: string
		registeredAt: timestamp
	}
	slice register["Register"]
		reg_ui-->Register
		Register-->Registered
```

## Description

A prospective Guest adds themselves as a new user of the system through the Registration UI by supplying `name`, `email`, and `password`. The `Register` command reads prior `Registered` events (DCB consistency boundary, resolved on the `email` axis — the only tag axis `Registered` declares) to enforce that an email address identifies exactly one guest; a second registration for an address already on file is rejected with `guest-already-registered`. On success the system emits a `Registered` event carrying the guest's `email` (the identity every downstream slice keys on), their `name`, and a `registeredAt` timestamp. The submitted `password` is a credential, not domain state, and is deliberately absent from the event.

This slice runs once per guest, at the front door: it is the prerequisite for booking, since `Book Room` reads `Registered` by `email` to confirm the booker exists. The preserved invariant is **at most one guest per `email`**.

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
			error guest-already-registered["A guest cannot be registered more than once"]
```
