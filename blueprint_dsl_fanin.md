# blueprint_dsl_fanin

The complete event model. The 33 slices defined here are listed in the sidebar — each one has its own specification with a focused view of just that slice's elements, plus description and tests sections.

## Model

```mermaid
eventModel
	actor Customer
	actor Admin
	aggregate Auth
	aggregate Profile
	aggregate Order
	aggregate Payment
	aggregate Support
	aggregate Loyalty

	%% --- Auth ---
	ui:Customer signup_ui["Sign Up"]
	command signUp["Sign Up"]
	domainEvent:Auth signedUp["Signed Up"] {
		customerId: UUID
		email: string
		signedUpAt: timestamp
	}
	slice sign_up["Sign Up"]
		signup_ui-->signUp
		signUp-->signedUp

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

	automation:Customer emailVerifier["Email Verifier"]
	command verifyEmail["Verify Email"]
	domainEvent:Auth emailVerified["Email Verified"] {
		customerId: UUID
		email: string
		verifiedAt: timestamp
	}
	slice verify_email["Verify Email"]
		emailVerifier-->verifyEmail
		verifyEmail-->emailVerified

	ui:Customer password_ui["Change Password"]
	command changePassword["Change Password"]
	domainEvent:Auth passwordChanged["Password Changed"] {
		customerId: UUID
		changedAt: timestamp
	}
	slice change_password["Change Password"]
		password_ui-->changePassword
		changePassword-->passwordChanged

	%% --- Profile ---
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

	ui:Customer address_ui["Add Address"]
	command addAddress["Add Address"]
	domainEvent:Profile addressAdded["Address Added"] {
		customerId: UUID
		addressId: UUID
		addressType: string
		addedAt: timestamp
	}
	slice add_address["Add Address"]
		address_ui-->addAddress
		addAddress-->addressAdded

	%% --- Order ---
	ui:Customer order_ui["Place Order"]
	command placeOrder["Place Order"]
	domainEvent:Order orderPlaced["Order Placed"] {
		customerId: UUID
		orderId: UUID
		total: decimal
		placedAt: timestamp
	}
	slice place_order["Place Order"]
		order_ui-->placeOrder
		placeOrder-->orderPlaced

	ui:Admin ship_ui["Ship Order"]
	command shipOrder["Ship Order"]
	domainEvent:Order orderShipped["Order Shipped"] {
		customerId: UUID
		orderId: UUID
		carrier: string
		shippedAt: timestamp
	}
	slice ship_order["Ship Order"]
		ship_ui-->shipOrder
		shipOrder-->orderShipped

	automation:Admin deliveryTracker["Delivery Tracker"]
	command markDelivered["Mark Delivered"]
	domainEvent:Order orderDelivered["Order Delivered"] {
		customerId: UUID
		orderId: UUID
		deliveredAt: timestamp
	}
	slice mark_delivered["Mark Delivered"]
		deliveryTracker-->markDelivered
		markDelivered-->orderDelivered

	ui:Customer return_ui["Return Order"]
	command returnOrder["Return Order"]
	domainEvent:Order orderReturned["Order Returned"] {
		customerId: UUID
		orderId: UUID
		reason: string
		returnedAt: timestamp
	}
	slice return_order["Return Order"]
		return_ui-->returnOrder
		returnOrder-->orderReturned

	%% --- Payment ---
	automation:Customer paymentRunner["Payment Runner"]
	command processPayment["Process Payment"]
	domainEvent:Payment paymentProcessed["Payment Processed"] {
		customerId: UUID
		paymentId: UUID
		amount: decimal
		processedAt: timestamp
	}
	slice process_payment["Process Payment"]
		paymentRunner-->processPayment
		processPayment-->paymentProcessed

	ui:Admin refund_ui["Issue Refund"]
	command issueRefund["Issue Refund"]
	domainEvent:Payment refundIssued["Refund Issued"] {
		customerId: UUID
		refundId: UUID
		amount: decimal
		issuedAt: timestamp
	}
	slice issue_refund["Issue Refund"]
		refund_ui-->issueRefund
		issueRefund-->refundIssued

	%% --- Support ---
	ui:Customer ticket_ui["Open Ticket"]
	command openTicket["Open Ticket"]
	domainEvent:Support ticketOpened["Ticket Opened"] {
		customerId: UUID
		ticketId: UUID
		subject: string
		openedAt: timestamp
	}
	slice open_ticket["Open Ticket"]
		ticket_ui-->openTicket
		openTicket-->ticketOpened

	ui:Admin resolve_ui["Resolve Ticket"]
	command resolveTicket["Resolve Ticket"]
	domainEvent:Support ticketResolved["Ticket Resolved"] {
		customerId: UUID
		ticketId: UUID
		resolution: string
		resolvedAt: timestamp
	}
	slice resolve_ticket["Resolve Ticket"]
		resolve_ui-->resolveTicket
		resolveTicket-->ticketResolved

	ui:Customer review_ui["Write Review"]
	command postReview["Post Review"]
	domainEvent:Support reviewPosted["Review Posted"] {
		customerId: UUID
		reviewId: UUID
		rating: int
		postedAt: timestamp
	}
	slice post_review["Post Review"]
		review_ui-->postReview
		postReview-->reviewPosted

	%% --- Loyalty ---
	automation:Customer loyaltyEngine["Loyalty Engine"]
	command awardPoints["Award Points"]
	domainEvent:Loyalty pointsEarned["Points Earned"] {
		customerId: UUID
		points: int
		reason: string
		earnedAt: timestamp
	}
	slice award_points["Award Points"]
		loyaltyEngine-->awardPoints
		awardPoints-->pointsEarned

	%% --- Read model: fan-in target ---
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}

	%% --- Per-event read slices (event → activityFeed) ---
	slice feed_signup["Feed: Signed Up"]
		signedUp-->activityFeed

	slice feed_login["Feed: Logged In"]
		loggedIn-->activityFeed

	slice feed_email_verified["Feed: Email Verified"]
		emailVerified-->activityFeed

	slice feed_password_changed["Feed: Password Changed"]
		passwordChanged-->activityFeed

	slice feed_profile_updated["Feed: Profile Updated"]
		profileUpdated-->activityFeed

	slice feed_address_added["Feed: Address Added"]
		addressAdded-->activityFeed

	slice feed_order_placed["Feed: Order Placed"]
		orderPlaced-->activityFeed

	slice feed_order_shipped["Feed: Order Shipped"]
		orderShipped-->activityFeed

	slice feed_order_delivered["Feed: Order Delivered"]
		orderDelivered-->activityFeed

	slice feed_order_returned["Feed: Order Returned"]
		orderReturned-->activityFeed

	slice feed_payment_processed["Feed: Payment Processed"]
		paymentProcessed-->activityFeed

	slice feed_refund_issued["Feed: Refund Issued"]
		refundIssued-->activityFeed

	slice feed_ticket_opened["Feed: Ticket Opened"]
		ticketOpened-->activityFeed

	slice feed_ticket_resolved["Feed: Ticket Resolved"]
		ticketResolved-->activityFeed

	slice feed_review_posted["Feed: Review Posted"]
		reviewPosted-->activityFeed

	slice feed_points_earned["Feed: Points Earned"]
		pointsEarned-->activityFeed

	ui:Admin activity_ui["Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
	}
	slice view_activity_feed["View Activity Feed"]
		activityFeed-->activity_ui
```
