# blueprint_sliceTests

Reference set of slice-test patterns matching Adam Dymitruk's four canonical Event Modeling test types: state change, state view, external state input, and external state output.

## Model

```mermaid
sliceTests
	test["State Change"]
		given
			domainEvent["Registered"]
			domainEvent["Room Added"]
		when
			command["Book Room"]
		then
			domainEvent["Room Booked"]

	test["State View"]
		given
			domainEvent["Paid"]
			domainEvent["Paid"]
		then
			readModel["Sales Report"]

	test["External State Input"]
		given
			domainEvent["GPS Update"]
			domainEvent["GPS Update"]
			domainEvent["GPS Update"]
			domainEvent["GPS Update"]
		when
			command["Translate To Location"]
		then
			domainEvent["Entered Hotel"]
			domainEvent["Exited Hotel"]

	test["External State Output"]
		given
			readModel["Stay Notifications to Send"]
		when
			command["Send Notification"]
		then
			domainEvent["Notification Sent"]
			domainEvent["Notification Failed"]
```
