# Issue Refund

<!-- slice id: issue_refund -->

## Model

```mermaid
eventModel
	actor Admin
	aggregate Payment
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
