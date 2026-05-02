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

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
