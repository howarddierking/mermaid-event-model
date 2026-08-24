# loan-originations

The [axon-poc](https://github.com/patrocinio/axon-poc) Loan Originations system modeled in Event Modeling notation. It is a CQRS / Event Sourcing domain: an applicant submits a loan, an underwriter approves or rejects it, and an approved loan is disbursed. State is never stored directly — it is reconstructed by replaying events, and each command declares (via `reads [...]`) the past events it must replay to enforce its business rule.

This same model is realized two ways in the repo: on `main` with the Axon Framework (Axon Server event store, Spring Boot), and on `aws-native` with native AWS services (DynamoDB Global Tables event store, Lambda command/query handlers, ElastiCache read model). The model below is implementation-agnostic and documents both.

## Model

```mermaid
eventModel
	actor Applicant
	actor Underwriter

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

	readModel loanView["Loan Read Model"] {
		*loanId: UUID
		applicantName: string
		requestedAmount: decimal
		status: string
		approvedAmount: decimal
		disbursementAccount: string
	}
	slice feed_submitted["Feed: Loan Submitted"]
		submitted-->loanView

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

	ui:Underwriter disburse_ui["Disbursement UI"] {
		loanId: UUID
		disbursementAccount: string
	}
	command disburseLoan["Disburse Loan"] {
		loanId: UUID
		disbursementAccount: string
	}
		reads [submitted, approved, rejected, disbursed] by loanId
	domainEvent disbursed["Loan Disbursed"] {
		*loanId: UUID
		disbursementAccount: string
		disbursedAt: timestamp
	}
	slice disburse_loan["Disburse Loan"]
		disburse_ui-->disburseLoan
		disburseLoan-->disbursed

	slice feed_approved["Feed: Loan Approved"]
		approved-->loanView

	slice feed_rejected["Feed: Loan Rejected"]
		rejected-->loanView

	slice feed_disbursed["Feed: Loan Disbursed"]
		disbursed-->loanView

	ui:Underwriter status_ui["Loan Status View"] {
		loanId: UUID
		status: string
		approvedAmount: decimal
	}
	slice view_loan_status["View Loan Status"]
		loanView-->status_ui
```
