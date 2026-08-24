# View Loan Status

<!-- slice id: view_loan_status -->

## Model

**Pattern:** State view

```mermaid
eventModel
	actor Underwriter
	readModel loanView["Loan Read Model"] {
		*loanId: UUID
		applicantName: string
		requestedAmount: decimal
		status: string
		approvedAmount: decimal
		disbursementAccount: string
	}
	ui:Underwriter status_ui["Loan Status View"] {
		loanId: UUID
		status: string
		approvedAmount: decimal
	}
	slice view_loan_status["View Loan Status"]
		loanView-->status_ui
```

## Description

An underwriter (or applicant) reads the current status of a loan from the read model. Queries never touch the event store — they read the pre-computed projection. This is the query side of CQRS: `GET /api/loans/{id}` and `GET /api/loans/status/{status}` are served entirely from the read model.

## Tests

```mermaid
sliceTests
	test["Shows the current loan status from the read model"]
		given
			readModel["Loan Read Model"] {
				loanId: UUID = "loan-001"
				status: string = "DISBURSED"
				approvedAmount: decimal = 115000
			}
		then
			ui["Loan Status View"] {
				loanId: UUID = "loan-001"
				status: string = "DISBURSED"
				approvedAmount: decimal = 115000
			}
```
