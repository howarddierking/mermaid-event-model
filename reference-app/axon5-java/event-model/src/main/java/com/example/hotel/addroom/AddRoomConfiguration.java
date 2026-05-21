package com.example.hotel.addroom;

import org.axonframework.eventsourcing.configuration.EventSourcedEntityModule;
import org.axonframework.eventsourcing.configuration.EventSourcingConfigurer;
import org.axonframework.messaging.commandhandling.configuration.CommandHandlingModule;

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
