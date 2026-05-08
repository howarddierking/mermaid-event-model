# blueprint_sliceTests

Reference set of slice-test patterns matching Adam Dymitruk's four canonical Event Modeling test types: state change, state view, external state input, and external state output. The State Change test demonstrates the data-section syntax — commands, events, and read models can carry typed fields the same way they do in eventModel diagrams.

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
