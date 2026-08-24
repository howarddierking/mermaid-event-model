# Approve Loan

<!-- slice id: approve_loan -->

## Model

**Pattern:** Command

```mermaid
eventModel
	actor Underwriter
	ui:Underwriter review_ui["Underwriting Queue"] {
		loanId: UUID
		applicantName: string
		requestedAmount: decimal
		status: string
	}
	command approveLoan["Approve Loan"] {
		loanId: UUID
		approvedAmount: decimal
		approvedBy: string
	}
		reads [submitted, approved, rejected, disbursed] by loanId
	domainEvent approved["Loan Approved"] {
		*loanId: UUID
		approvedAmount: decimal
		approvedBy: string
		approvedAt: timestamp
	}
	slice approve_loan["Approve Loan"]
		review_ui-->approveLoan
		approveLoan-->approved
```

## Description

An underwriter approves a submitted loan, recording the approved amount and who approved it. The command replays all prior events for the loan to reconstruct its status and enforces the invariant that only a `SUBMITTED` loan can be approved. Approving a loan that is already approved, rejected, or disbursed is rejected.

## Tests

```mermaid
sliceTests
	test["Approves a submitted loan"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
				requestedAmount: decimal = 120000
			}
		when
			command["Approve Loan"] {
				loanId: UUID = "loan-001"
				approvedAmount: decimal = 115000
				approvedBy: string = "Sarah Chen"
			}
		then
			domainEvent["Loan Approved"] {
				loanId: UUID = "loan-001"
				approvedAmount: decimal = 115000
				approvedBy: string = "Sarah Chen"
			}

	test["Rejects approval when loan is already approved"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Approved"] {
				loanId: UUID = "loan-001"
				approvedAmount: decimal = 115000
			}
		when
			command["Approve Loan"] {
				loanId: UUID = "loan-001"
				approvedAmount: decimal = 115000
				approvedBy: string = "Sarah Chen"
			}
		then
			error can-only-approve-submitted["Can only approve a SUBMITTED loan (current: APPROVED)"]
```
