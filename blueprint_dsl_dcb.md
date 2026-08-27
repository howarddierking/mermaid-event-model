# blueprint_dsl_dcb

The same hotel-booking model rewritten in Dynamic Consistency Boundary style: no aggregates, with `reads [...]` clauses on commands declaring the past event types they replay for consistency. Domain events without a `:<Aggregate>` qualifier land in a synthesized `Events` lane below `Time`.

## Model

```mermaid
eventModel
	actor Manager
	actor Guest
	actor System

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

	ui:Manager room_ui["Room Management"] {
		roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	command addRoom["Add Room"] {
		roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
		reads [roomAdded] by roomNumber
	domainEvent roomAdded["Room Added"] {
		*roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	readModel avail["Room Availability"] {
		*roomNumber: int
		*night: date
		roomType: string
		capacity: int
		isAvailable: boolean
	}
	slice add_room["Add Room"]
		room_ui-->addRoom
		addRoom-->roomAdded

	externalEvent weekElapsed["Week Elapsed"] {
		occurredAt: date
	}
	readModel horizon["Availability Horizon"] {
		*roomNumber: int
		roomType: string
		capacity: int
		seededThrough: date
		requiredThrough: date
	}
	automation:System availabilityMaintainer["Availability Maintainer"]
	command rollAvailability["Roll Availability"] {
		roomNumber: int
		roomType: string
		capacity: int
		fromNight: date
		throughNight: date
	}
		reads [availabilityRolled] by roomNumber
	domainEvent availabilityRolled["Availability Rolled"] {
		*roomNumber: int
		roomType: string
		capacity: int
		fromNight: date
		throughNight: date
		rolledAt: timestamp
	}
	slice track_availability_horizon["Track Availability Horizon"]
		roomAdded-->horizon
		weekElapsed-->horizon
		availabilityRolled-->horizon

	slice roll_availability["Roll Availability"]
		horizon-->availabilityMaintainer
		availabilityMaintainer-->rollAvailability
		rollAvailability-->availabilityRolled

	slice view_room_availability["View Room Availability"]
		availabilityRolled-->avail
		booked-->avail
		avail-->booking_ui

	ui:Guest booking_ui["Booking Screen"] {
		roomNumber: int
		roomType: string
		capacity: int
		checkIn: date
		checkOut: date
	}
	command bookRoom["Book Room"] {
		email: string
		roomNumber: int
		checkIn: date
		checkOut: date
	}
		reads [roomAdded, booked, checkedOut] by roomNumber
		reads [Registered] by email
	domainEvent booked["Room Booked"] {
		*bookingId: UUID
		*roomNumber: int
		email: string
		checkIn: date
		checkOut: date
		bookedAt: timestamp
	}
	slice book_room["Book Room"]
		booking_ui-->bookRoom
		bookRoom-->booked

	readModel cleaning_schedule["Cleaning Schedule"] {
		*roomNumber: int
		guestCheckOut: date
		cleaningStatus: string
	}
	ui:Manager maintenance_ui["Maintenance UI"] {
		roomNumber: int
		cleaningStatus: string
	}
	command readyRoom["Ready Room"] {
		roomNumber: int
		cleanedBy: string
	}
		reads [roomAdded, checkedOut, ready] by roomNumber
	domainEvent ready["Room Readied"] {
		*roomNumber: int
		readiedAt: timestamp
	}
	slice view_cleaning_schedule["View Cleaning Schedule"]
		booked-->cleaning_schedule
		cleaning_schedule-->maintenance_ui

	slice ready_room["Ready Room"]
		maintenance_ui-->readyRoom
		readyRoom-->ready

	ui:Guest checkin_ui["Check-in Screen"] {
		bookingId: UUID
		guestName: string
		roomNumber: int
	}
	command checkin["Check-in"] {
		bookingId: UUID
	}
		reads [booked, checkedIn] by bookingId
	domainEvent checkedIn["Checked In"] {
		*bookingId: UUID
		*email: string
		roomNumber: int
		checkedInAt: timestamp
	}
	readModel guestRoster["Guest Roster"] {
		*email: string
		guestName: string
		roomNumber: int
		checkedInAt: timestamp
		isPresent: boolean
	}
	slice check_in["Check-in"]
		checkin_ui-->checkin
		checkin-->checkedIn

	externalEvent positionUpdated["Position Updated"] {
		email: string
		latitude: float
		longitude: float
		timestamp: timestamp
	}
	command hotelProximityTranslator["Hotel Proximity Translator"] {
		email: string
	}
		reads [checkedIn, checkedOut] by email
	domainEvent guestLeft["Guest Left Hotel"] {
		email: string
		departedAt: timestamp
	}
	slice hotel_proximity_translator["Hotel Proximity Translator"]
		positionUpdated-->hotelProximityTranslator
		hotelProximityTranslator-->guestLeft

	automation:System checkOutAutomation["Check-out Automation"]
	command checkOut["Checked Out"] {
		bookingId: UUID
	}
		reads [checkedIn, checkedOut] by bookingId
	domainEvent checkedOut["Checked Out"] {
		*bookingId: UUID
		*roomNumber: int
		*email: string
		checkedOutAt: timestamp
	}
	slice track_guest_presence["Track Guest Presence"]
		checkedIn-->guestRoster
		guestLeft-->guestRoster

	slice check_out_automation["Check-out Automation"]
		guestRoster-->checkOutAutomation
		checkOutAutomation-->checkOut
		checkOut-->checkedOut

	ui:Guest payment_ui["Payment UI"] {
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
	}
	command pay["Pay"] {
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
	}
		reads [booked, paymentRequested, paymentSucceeded] by bookingId
	domainEvent paymentRequested["Payment Requested"] {
		*paymentId: UUID
		*bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		requestedAt: timestamp
	}
	readModel paymentsToProcess["Payments to Process"] {
		*paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		status: string
	}
	slice request_payment["Request Payment"]
		payment_ui-->pay
		pay-->paymentRequested

	automation:System paymentProcessor["Payment Processor"]
	command submitPayment["Submit Payment"] {
		paymentId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
	}
		reads [paymentRequested, paymentSubmitted] by paymentId
	domainEvent paymentSubmitted["Payment Submitted"] {
		*paymentId: UUID
		bookingId: UUID
		amount: decimal
		submittedAt: timestamp
	}
	slice track_outstanding_payments["Track Outstanding Payments"]
		paymentRequested-->paymentsToProcess
		paymentSubmitted-->paymentsToProcess
		paymentSucceeded-->paymentsToProcess

	slice payment_processor["Payment Processor"]
		paymentsToProcess-->paymentProcessor
		paymentProcessor-->submitPayment
		submitPayment-->paymentSubmitted

	externalEvent gatewayConfirmed["Gateway Confirmed"] {
		paymentId: UUID
		transactionRef: string
		confirmedAt: timestamp
	}
	command processPayment["Process Payment"] {
		paymentId: UUID
		gatewayRef: string
	}
		reads [paymentSubmitted, paymentSucceeded] by paymentId
	domainEvent paymentSucceeded["Payment Succeeded"] {
		*paymentId: UUID
		*bookingId: UUID
		amount: decimal
		transactionRef: string
		succeededAt: timestamp
	}
	slice gateway_confirmation["Gateway Confirmation"]
		gatewayConfirmed-->processPayment
		processPayment-->paymentSucceeded

	readModel salesReport["Sales Report"] {
		totalRevenue: decimal
		transactionCount: int
		averageBookingValue: decimal
		revenueByRoomType: string
	}
	ui:Manager sales_ui["Sales Report UI"] {
		totalRevenue: decimal
		transactionCount: int
		averageBookingValue: decimal
		revenueByRoomType: string
	}
	slice view_sales_report["View Sales Report"]
		paymentSucceeded-->salesReport
		salesReport-->sales_ui
```
