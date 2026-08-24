# Reject Loan

<!-- slice id: reject_loan -->

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
	command rejectLoan["Reject Loan"] {
		loanId: UUID
		reason: string
		rejectedBy: string
	}
		reads [submitted, approved, rejected, disbursed] by loanId
	domainEvent rejected["Loan Rejected"] {
		*loanId: UUID
		reason: string
		rejectedBy: string
		rejectedAt: timestamp
	}
	slice reject_loan["Reject Loan"]
		review_ui-->rejectLoan
		rejectLoan-->rejected
```

## Description

An underwriter rejects a submitted loan, recording the reason and who rejected it. Like approval, the command replays the loan's events to reconstruct its status and enforces that only a `SUBMITTED` loan can be rejected. This is a terminal state — a rejected loan cannot be approved or disbursed.

## Tests

```mermaid
sliceTests
	test["Rejects a submitted loan"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-002"
				requestedAmount: decimal = 500000
			}
		when
			command["Reject Loan"] {
				loanId: UUID = "loan-002"
				reason: string = "Amount exceeds risk threshold"
				rejectedBy: string = "Risk Engine"
			}
		then
			domainEvent["Loan Rejected"] {
				loanId: UUID = "loan-002"
				reason: string = "Amount exceeds risk threshold"
				rejectedBy: string = "Risk Engine"
			}

	test["Rejects the reject command when loan is already disbursed"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Approved"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Disbursed"] {
				loanId: UUID = "loan-001"
			}
		when
			command["Reject Loan"] {
				loanId: UUID = "loan-001"
				reason: string = "Too late"
				rejectedBy: string = "Ops"
			}
		then
			error can-only-reject-submitted["Can only reject a SUBMITTED loan (current: DISBURSED)"]
```
