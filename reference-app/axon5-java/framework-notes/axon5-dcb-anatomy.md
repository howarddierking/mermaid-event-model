# Axon 5 DCB slice anatomy

Distilled from `AxonIQ/university-demo` (Axon Framework 5.0.0). This is the
mapping the code-gen skill should use when turning an Event Modeling slice
into Java code for the Axon 5 / DCB programming model.

## File layout per slice

One package per command in the event-model library:

```
com.example.hotel.<sliceName>/
  <CommandName>.java                 # record + @TargetEntityId
  <EventName>.java                   # record + @EventTag fields
  <CommandName>CommandHandler.java   # handler + nested State entity
  <CommandName>Configuration.java    # static configure(EventSourcingConfigurer)
  <ConsistencyId>.java               # value record used as entity key (optional)
  <DomainException>.java             # business rule violations (optional)
```

Each slice's `Configuration.configure(EventSourcingConfigurer)` is called from
the shared `EventModelModule.contribute(...)` aggregator, which is what
consuming processes invoke.

## Command record

A record carrying the command payload. It must expose the entity ID that the
framework uses to load slice state. The ID is exposed via a method annotated
`@TargetEntityId` (return type can be a value record).

```java
public record AddRoom(int roomNumber, int floor, String roomType, int capacity) {

    @TargetEntityId
    private RoomNumber id() {
        return new RoomNumber(roomNumber);
    }
}
```

Rules:
- The `@TargetEntityId` method may be private.
- Its return type must match the ID class registered in the configuration
  (`EventSourcedEntityModule.autodetected(IdClass, StateClass)`).

## Event record

A record carrying the event payload. Fields that participate in the DCB
consistency boundary are annotated `@EventTag(key="<tagName>")`. Tags drive
which past events the framework replays to hydrate slice state and form the
`AppendCondition` enforced at commit time.

```java
public record RoomAdded(
        UUID roomId,
        @EventTag(key = HotelTags.ROOM_NUMBER) int roomNumber,
        int floor,
        String roomType,
        int capacity
) {}
```

Conventions:
- Use a typed constant (`HotelTags.ROOM_NUMBER`) for the tag key string —
  shared across the event's `@EventTag` and the handler's
  `@EventCriteriaBuilder` so they stay in sync.
- Tag values are stringified (`String.valueOf(...)`) by the framework when
  matching, but the field can be any type.

## Command handler

A plain class with one `@CommandHandler` method. State is projected from
past events declared by the `@EventCriteriaBuilder` and injected via
`@InjectEntity`. New events are appended through an `EventAppender`.

```java
class AddRoomCommandHandler {

    @CommandHandler
    void handle(AddRoom command, @InjectEntity State state, EventAppender appender) {
        if (state.exists) {
            throw new HotelModelException("Room with roomNumber already exists");
        }
        appender.append(new RoomAdded(
                UUID.randomUUID(), command.roomNumber(),
                command.floor(), command.roomType(), command.capacity()
        ));
    }

    @EventSourcedEntity
    static class State {
        private boolean exists = false;

        @EntityCreator
        public State() {}

        @EventSourcingHandler
        void evolve(RoomAdded event) { this.exists = true; }

        @EventCriteriaBuilder
        private static EventCriteria resolveCriteria(RoomNumber id) {
            return EventCriteria
                    .havingTags(Tag.of(HotelTags.ROOM_NUMBER, String.valueOf(id.value())))
                    .andBeingOneOfTypes(RoomAdded.class.getName());
        }
    }
}
```

Notes:
- The nested `State` class is package-private and lives inside the handler
  file. Keep it small — it only holds the fields needed to decide the command.
- `@EventCriteriaBuilder`'s parameter is the ID type, not the command type.
- For slices that read multiple event types or multiple tag dimensions, build
  the criteria with `EventCriteria.either(criteriaA, criteriaB)`.

### Mapping from `reads [...]` to `EventCriteria`

In the DSL:

```
command addRoom reads [ra] { ... }
```

`reads [ra]` lists the event types whose past instances the command must
consult. In Axon 5 this becomes the `EventCriteria` returned by
`@EventCriteriaBuilder`:

- One event type → `havingTags(...).andBeingOneOfTypes(RoomAdded.class.getName())`.
- Multiple event types sharing a tag dimension → same call with several
  `class.getName()` values.
- Multiple tag dimensions → `EventCriteria.either(criteriaA, criteriaB)`.

The tag dimensions come from the domain identity that defines the
consistency boundary (often a single field of the command). For `add_room`
the dimension is `roomNumber`.

## Slice configuration

Static `configure` method that registers the entity and a
`CommandHandlingModule` carrying the handler. One per slice.

```java
public final class AddRoomConfiguration {

    public static EventSourcingConfigurer configure(EventSourcingConfigurer configurer) {
        var stateEntity = EventSourcedEntityModule
                .autodetected(RoomNumber.class, AddRoomCommandHandler.State.class);
        var commandHandling = CommandHandlingModule
                .named("AddRoom")
                .commandHandlers()
                .annotatedCommandHandlingComponent(c -> new AddRoomCommandHandler());
        return configurer
                .registerEntity(stateEntity)
                .registerCommandHandlingModule(commandHandling);
    }

    private AddRoomConfiguration() {}
}
```

## Aggregator (one per event-model library)

```java
public final class EventModelModule {

    public static EventSourcingConfigurer contribute(EventSourcingConfigurer configurer) {
        configurer = AddRoomConfiguration.configure(configurer);
        // future slices wired here
        return configurer;
    }

    private EventModelModule() {}
}
```

This is the only entry point consuming processes call.

## Error outcomes (`error["..."]` in sliceTests)

When a slice's "then" block contains `error["<message>"]`, the handler enforces
the corresponding rule by throwing `com.example.hotel.shared.HotelModelException`
with the **exact message string** from the DSL — no wrapping, no formatting.
That keeps the test assertion (`exception(HotelModelException.class, "<message>")`)
a one-line mapping from the DSL.

```java
if (state.exists) {
    throw new HotelModelException("Room with roomNumber already exists");
}
```

If multiple `error[...]` entries appear in a single test, each maps to a
distinct branch in the handler with the corresponding message. Combine
errors with normal event outcomes only when the slice can both emit and
reject within one command flow — DCB handlers generally do one or the
other.

## JUnit slice tests (mapping from the sliceTests DSL)

Each test in the DSL translates to one JUnit method using `axon-test`'s
`AxonTestFixture`:

| sliceTests DSL                 | JUnit assertion                                          |
|--------------------------------|----------------------------------------------------------|
| `given` events                 | `.given().event(...)` (or `.noPriorActivity()`)          |
| `when command["..."]`          | `.when().command(...)`                                   |
| `then domainEvent["..."]`      | `.then().success().events(...)` or `.eventsSatisfy(...)` |
| `then error["<message>"]`      | `.then().exception(HotelModelException.class, "<msg>")`  |

Use `eventsSatisfy(...)` rather than `events(...)` when the event carries a
generated value (UUIDs, timestamps) that the handler produces — assert only
the fields the slice actually drives from the command.

The shared `TestFixtures.slice(SliceConfiguration::configure)` factory
spins up the fixture for one slice without an Axon Server connection.

## Bootstrap (one per process — not part of the lib)

Each process (web-api, future event-listener, ...) constructs its own
`EventSourcingConfigurer`, points it at Axon Server, calls
`EventModelModule.contribute(configurer)`, and starts it. The
`CommandGateway` is extracted from the running configuration.

See `web-api/src/main/java/com/example/hotel/api/AxonBootstrap.java` for the
Quarkus-flavoured version.
