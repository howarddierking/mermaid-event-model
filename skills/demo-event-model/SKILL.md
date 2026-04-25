---
name: demo-event-model
description: Write the canonical hotel-booking demo Event Model DSL to a file (default target is `blueprint_dsl` in the project root). Useful for resetting the reference DSL or seeding a new file with a working example that exercises every DSL feature (actors, aggregates, UIs, commands, domain events, read models, automations, data sections, slices).
argument-hint: [target-file-path]
---

# Demo Event Model Generator

Write the canonical hotel-booking Event Model DSL to a target file.

## Input

The argument `$ARGUMENTS` is the target file path. If no argument is provided, default to `blueprint_dsl` in the project root.

## What to do

1. Read the template file `template.dsl` located in the same directory as this `SKILL.md`. Use the `Bash` tool with `dirname` on the path to this file to locate it robustly — do not hard-code an absolute path.

2. Write its contents verbatim to the target file. Preserve tab indentation exactly — the DSL parser is indent-aware and uses tabs.

3. Confirm to the user what you wrote and where.

## What the template contains

The template is a complete hotel-booking event model that exercises every DSL feature:

- **Actors**: Manager, Guest
- **Aggregates**: Inventory, Auth, Payment, GPS
- **UIs** with data sections: Registration, Room Management, Booking, Maintenance, Check-in, Payment, Sales Report
- **Commands** with data sections: Register, Add Room, Book Room, Ready Room, Check-in, Checked Out, Pay, Process Payment, and a fieldless `hotelProximityTranslator`
- **Domain events** with data sections: Registered, Room Added, Room Booked, Room Readied, Checked In, Position Updated, Guest Left Hotel, Checked Out, Payment Requested, Payment Succeeded
- **Read models** with data sections: Room Availability, Cleaning Schedule, Guest Roster, Payments to Process, Sales Report
- **Automations**: Check-out Automation (Manager), Payment Processor (Guest)
- **Slices** covering every edge in the model (16 slices total), demonstrating both command slices (ui/automation → command → event) and read slices (event → readModel → ui/automation)
- **A cycle**: `paymentSucceeded ↔ paymentsToProcess` — exercises the renderer's back-edge handling

## Important

- Do NOT modify the template file itself; this skill only copies it to the target.
- If the target file already exists, confirm with the user before overwriting.
