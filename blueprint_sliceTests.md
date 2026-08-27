# blueprint_sliceTests

Reference set of slice-test patterns matching Adam Dymitruk's four canonical Event Modeling test types: state change, state view, external state input, and external state output. The State Change test demonstrates the data-section syntax — commands, events, and read models can carry typed fields the same way they do in eventModel diagrams. A fifth test covers the **empty result** variant of a state view, which uses the two sliceTests-only constructs: a `ui` in the `when` block carrying the query criteria, and `none[...]` asserting that nothing matched.

## Model

```mermaid
sliceTests
	test["State Change"]
		given
			domainEvent["Registered"] {
				guestId: UUID
				name: string
				email: string
			}
			domainEvent["Room Added"] {
				roomId: UUID
				roomNumber: int
				roomType: string
			}
		when
			command["Book Room"] {
				guestId: UUID
				roomId: UUID
				checkIn: date
				checkOut: date
			}
		then
			domainEvent["Room Booked"] {
				bookingId: UUID
				guestId: UUID
				roomId: UUID
				bookedAt: timestamp
			}

	test["State View"]
		given
			domainEvent["Paid"]
			domainEvent["Paid"]
		then
			readModel["Sales Report"] {
				totalRevenue: decimal
				transactionCount: int
				averageBookingValue: decimal
			}

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

	test["State View — Empty Result"]
		given
			domainEvent["Availability Rolled"] {
				roomNumber: int = 101
				fromNight: date = 2026-08-25
				throughNight: date = 2027-02-21
			}
		when
			ui["Booking Screen"] {
				checkIn: date = 2027-03-01
				checkOut: date = 2027-03-04
			}
		then
			none["No rooms match the requested dates"]

	test["External State Output"]
		given
			readModel["Stay Notifications to Send"] {
				notificationId: UUID
				guestId: UUID
				message: string
				scheduledAt: timestamp
			}
		when
			command["Send Notification"]
		then
			domainEvent["Notification Sent"]
			domainEvent["Notification Failed"]
```
