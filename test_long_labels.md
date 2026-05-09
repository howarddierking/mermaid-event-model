# test_long_labels

Reproducer for [issue #2](https://github.com/howarddierking/mermaid-event-model/issues/2) — DCB tag rectangles extend well past the text when labels span multiple words.

The `doThing` command's `reads` clause references events whose labels run 26+ characters across 3 words. With the old heuristic of `length × 6.5 px/char`, the tag rect was sized roughly 30–40px wider than the actually-rendered text, leaving a noticeable gap between the last letter and the tag's right edge.

## Model

```mermaid
eventModel
	actor User

	ui:User user_ui["UI"]
	command doThing["Do Thing"] reads [profile_confirmed, payment_received_today]
	domainEvent profile_confirmed["Customer Profile Was Confirmed"]
	domainEvent payment_received_today["Payment Received Earlier Today"]
	domainEvent thing_done["Thing Done"]

	user_ui-->doThing
	doThing-->thing_done
```
