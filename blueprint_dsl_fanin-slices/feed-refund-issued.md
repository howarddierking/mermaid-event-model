# Feed: Refund Issued

<!-- slice id: feed_refund_issued -->

## Model

```mermaid
eventModel
	aggregate Payment
	domainEvent:Payment refundIssued["Refund Issued"] {
		customerId: UUID
		refundId: UUID
		amount: decimal
		issuedAt: timestamp
	}
	readModel activityFeed["Customer Activity Timeline"] {
		customerId: UUID
		eventType: string
		summary: string
		occurredAt: timestamp
		severity: string
		linkedEntityId: UUID
	}
	slice feed_refund_issued["Feed: Refund Issued"]
		refundIssued-->activityFeed
```

## Description

_Describe the high-level intent of this slice in prose. What user-visible capability does it represent? Why does it matter? When does it run, and what constraint or invariant does it preserve?_

## Tests

```eventModelSlice
# Test specifications for this slice will be authored here in the
# eventModelSlice DSL. The grammar is being defined separately —
# leave this block as a placeholder until the spec lands, then revise.
```
