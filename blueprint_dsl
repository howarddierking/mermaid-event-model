eventModel
	actor Manager
	actor Guest
	aggregate Inventory
	aggregate Auth
	aggregate Payment
	aggregate GPS

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
	domainEvent:Auth Registered {
		guestId: UUID
		name: string
		email: string
		registeredAt: timestamp
	}
	slice registration_slice["Registration"]
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
	domainEvent:Auth ra["Room Added"] {
		roomId: UUID
		roomNumber: int
		floor: int
		roomType: string
		capacity: int
	}
	readModel avail["Room Availability"] {
		roomId: UUID
		roomNumber: int
		roomType: string
		isAvailable: boolean
		nextCheckIn: date
	}

	slice addroom_slice["Add Room"]
		room_ui-->addRoom
		addRoom-->ra
	
	slice show_availability["Show Availability"]
		ra-->avail
		avail-->booking_ui

	ui:Guest booking_ui["Booking Screen"] {
		roomId: UUID
		roomType: string
		checkIn: date
		checkOut: date
	}
	command bookRoom["Book Room"] {
		guestId: UUID
		roomId: UUID
		checkIn: date
		checkOut: date
	}
	domainEvent:Inventory booked["Room Booked"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkIn: date
		checkOut: date
		bookedAt: timestamp
	}

	slice book_room["Book Room"]
		booking_ui-->bookRoom
		bookRoom-->booked

	readModel cleaning_schedule["Cleaning Schedule"] {
		roomId: UUID
		roomNumber: int
		guestCheckOut: date
		cleaningStatus: string
	}
	ui:Manager maintenance_ui["Maintenance UI"] {
		roomId: UUID
		roomNumber: int
		cleaningStatus: string
	}
	command readyRoom["Ready Room"] {
		roomId: UUID
		cleanedBy: string
	}
	domainEvent:Inventory ready["Room Readied"] {
		roomId: UUID
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
		guestId: UUID
	}
	domainEvent:Inventory checkedIn["Checked In"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkedInAt: timestamp
	}
	readModel guestRoster["Guest Roster"] {
		guestId: UUID
		guestName: string
		roomNumber: int
		checkedInAt: timestamp
		isPresent: boolean
	}

	slice check_in["Check In"]
		checkin_ui-->checkin
		checkin-->checkedIn

	slice update_guest_roster["Update Guest Roster"]
		checkedIn-->guestRoster

	domainEvent:GPS positionUpdated["Position Updated"] {
		guestId: UUID
		latitude: float
		longitude: float
		timestamp: timestamp
	}
	command hotelProximityTranslator["Hotel Proximity Translator"]
	domainEvent:Inventory guestLeft["Guest Left Hotel"] {
		guestId: UUID
		departedAt: timestamp
	}

	slice detect_guest_departure["Detect Guest Departure"]
		positionUpdated-->hotelProximityTranslator
		hotelProximityTranslator-->guestLeft

	slice track_guest_presence["Track Guest Presence"]
		guestLeft-->guestRoster

	automation:Manager checkOutAutomation["Check-out Automation"]
	command checkOut["Checked Out"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
	}
	domainEvent:Inventory checkedOut["Checked Out"] {
		bookingId: UUID
		guestId: UUID
		roomId: UUID
		checkedOutAt: timestamp
	}

	slice trigger_checkout["Trigger Check-out"]
		guestRoster-->checkOutAutomation

	slice check_out["Check Out"]
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
	domainEvent:Payment paymentRequested["Payment Requested"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		requestedAt: timestamp
	}
	readModel paymentsToProcess["Payments to Process"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		currency: string
		paymentMethod: string
		status: string
	}

	slice request_payment["Request Payment"]
		payment_ui-->pay
		pay-->paymentRequested

	slice show_payments_to_process["Show Payments to Process"]
		paymentRequested-->paymentsToProcess

	automation:Guest paymentProcessor["Payment Processor"]
	externalEvent gatewayConfirmed["Gateway Confirmed"] {
		paymentId: UUID
		transactionRef: string
		confirmedAt: timestamp
	}
	command processPayment["Process Payment"] {
		paymentId: UUID
		gatewayRef: string
	}
	domainEvent:Payment paymentSucceeded["Payment Succeeded"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		transactionRef: string
		succeededAt: timestamp
	}

	slice trigger_payment_processing["Trigger Payment Processing"]
		paymentsToProcess-->paymentProcessor

	slice process_payment["Process Payment"]
		paymentProcessor-->processPayment
		gatewayConfirmed-->processPayment
		processPayment-->paymentSucceeded

	slice update_payment_status["Update Payment Status"]
		paymentSucceeded-->paymentsToProcess

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
	