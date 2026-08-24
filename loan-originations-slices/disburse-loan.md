# Disburse Loan

<!-- slice id: disburse_loan -->

## Model

**Pattern:** Command

```mermaid
eventModel
	actor Underwriter
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
```

## Description

Funds are released to the borrower's account. The command replays the loan's events to reconstruct its status and enforces the core lifecycle invariant: only an `APPROVED` loan can be disbursed. Attempting to disburse a loan that is still `SUBMITTED` (or one that was rejected) is rejected — this is the primary business rule the domain protects.

## Tests

```mermaid
sliceTests
	test["Disburses an approved loan"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
			}
			domainEvent["Loan Approved"] {
				loanId: UUID = "loan-001"
				approvedAmount: decimal = 115000
			}
		when
			command["Disburse Loan"] {
				loanId: UUID = "loan-001"
				disbursementAccount: string = "ACH-0012345678"
			}
		then
			domainEvent["Loan Disbursed"] {
				loanId: UUID = "loan-001"
				disbursementAccount: string = "ACH-0012345678"
			}

	test["Rejects disbursement of a loan that is not approved"]
		given
			domainEvent["Loan Application Submitted"] {
				loanId: UUID = "loan-001"
			}
		when
			command["Disburse Loan"] {
				loanId: UUID = "loan-001"
				disbursementAccount: string = "ACH-0012345678"
			}
		then
			error can-only-disburse-approved["Can only disburse an APPROVED loan (current: SUBMITTED)"]
```
