package com.example.hotel;

import com.example.hotel.addroom.AddRoomConfiguration;
import org.axonframework.eventsourcing.configuration.EventSourcingConfigurer;

/**
 * Self-registration entry point for the event-model library. Each consuming
 * process (web-api, future event-listener, etc.) calls {@link #contribute}
 * to wire every slice into its own {@link EventSourcingConfigurer}.
 *
 * <p>Add new slices here, not at the call site, so consumers stay framework-
 * agnostic and never need to know which slices exist.
 */
public final class EventModelModule {

    public static EventSourcingConfigurer contribute(EventSourcingConfigurer configurer) {
        configurer = AddRoomConfiguration.configure(configurer);
        return configurer;
    }

    private EventModelModule() {}
}
