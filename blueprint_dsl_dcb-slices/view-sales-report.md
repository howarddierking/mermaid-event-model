# View Sales Report

<!-- slice id: view_sales_report -->

## Model

<!-- Derived from the parent eventModel and refreshed on every spec-slices run. Do not hand-edit. -->

**Pattern:** View

```mermaid
eventModel
	actor Manager
	domainEvent paymentSucceeded["Payment Succeeded"] {
		paymentId: UUID
		bookingId: UUID
		amount: decimal
		transactionRef: string
		succeededAt: timestamp
	}
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

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```mermaid
sliceTests
	test["Describe what this test verifies"]
		given
			# Preconditions: events that have already occurred,
			# read models that must be present.
		when
			# The command (or signal) under test. Omit `when`
			# for state-view tests that only project a read model.
		then
			# Expected outcomes: emitted events, populated read
			# models, signals to external systems.
```
