# Submit Loan

<!-- slice id: submit_loan -->

## Model

**Pattern:** Command

```mermaid
eventModel
	actor Applicant
	ui:Applicant apply_ui["Loan Application"] {
		applicantName: string
		requestedAmount: decimal
		purpose: string
	}
	command submitLoan["Submit Loan"] {
		applicantName: string
		requestedAmount: decimal
		purpose: string
	}
	domainEvent submitted["Loan Application Submitted"] {
		*loanId: UUID
		applicantName: string
		requestedAmount: decimal
		purpose: string
		submittedAt: timestamp
	}
	slice submit_loan["Submit Loan"]
		apply_ui-->submitLoan
		submitLoan-->submitted
```

## Description

An applicant submits a new loan application. This is the creation command for the loan aggregate — it has no prior state to validate against, so it always succeeds and emits a `Loan Application Submitted` event that establishes the loan in the `SUBMITTED` status. Every subsequent command in the lifecycle replays this event (and its successors) to reconstruct the loan's state.

## Tests

```mermaid
sliceTests
	test["Submits a new loan application"]
		when
			command["Submit Loan"] {
				applicantName: string = "Maria Garcia"
				requestedAmount: decimal = 120000
				purpose: string = "Home Purchase"
			}
		then
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
				applicantName: string = "Maria Garcia"
				requestedAmount: decimal = 120000
				purpose: string = "Home Purchase"
			}
```
