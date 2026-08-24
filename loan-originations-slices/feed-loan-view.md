# Feed: Loan Read Model

<!-- slice id: feed_submitted -->

## Model

**Pattern:** Read model projection

```mermaid
eventModel
	domainEvent submitted["Loan Application Submitted"] {
		*loanId: UUID
		applicantName: string
		requestedAmount: decimal
		purpose: string
		submittedAt: timestamp
	}
	domainEvent approved["Loan Approved"] {
		*loanId: UUID
		approvedAmount: decimal
		approvedBy: string
		approvedAt: timestamp
	}
	domainEvent rejected["Loan Rejected"] {
		*loanId: UUID
		reason: string
		rejectedBy: string
		rejectedAt: timestamp
	}
	domainEvent disbursed["Loan Disbursed"] {
		*loanId: UUID
		disbursementAccount: string
		disbursedAt: timestamp
	}
	readModel loanView["Loan Read Model"] {
		*loanId: UUID
		applicantName: string
		requestedAmount: decimal
		status: string
		approvedAmount: decimal
		disbursementAccount: string
	}
	slice feed_submitted["Feed: Loan Read Model"]
		submitted-->loanView
		approved-->loanView
		rejected-->loanView
		disbursed-->loanView
```

## Description

The projector consumes every loan event and maintains the `Loan Read Model` — the query-side view of each loan. This is the CQRS read path: the read model is completely separate from the event store and is disposable — it can be rebuilt at any time by replaying the event stream. In the Axon implementation this is an `@EventHandler` projection; in the AWS-native implementation it is a Lambda triggered by DynamoDB Streams writing to ElastiCache Redis.

## Tests

```mermaid
sliceTests
	test["Projects a submitted loan into the read model"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
				applicantName: string = "Maria Garcia"
				requestedAmount: decimal = 120000
			}
		then
			readModel["Loan Read Model"] {
				loanId: UUID = "loan-001"
				applicantName: string = "Maria Garcia"
				status: string = "SUBMITTED"
			}

	test["Reflects the approved status and amount"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Approved"] {
				loanId: UUID = "loan-001"
				approvedAmount: decimal = 115000
			}
		then
			readModel["Loan Read Model"] {
				loanId: UUID = "loan-001"
				status: string = "APPROVED"
				approvedAmount: decimal = 115000
			}

	test["Reflects the disbursed status"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Approved"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Disbursed"] {
				loanId: UUID = "loan-001"
				disbursementAccount: string = "ACH-0012345678"
			}
		then
			readModel["Loan Read Model"] {
				loanId: UUID = "loan-001"
				status: string = "DISBURSED"
				disbursementAccount: string = "ACH-0012345678"
			}
```
