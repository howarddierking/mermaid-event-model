package com.example.hotel;

import org.axonframework.eventsourcing.configuration.EventSourcingConfigurer;
import org.axonframework.test.fixture.AxonTestFixture;

import java.util.function.UnaryOperator;

/**
 * Single-slice {@link AxonTestFixture} factory. Wires only the slice under
 * test (no Axon Server connection) so each test is fast and self-contained.
 */
public final class TestFixtures {

    public static AxonTestFixture slice(UnaryOperator<EventSourcingConfigurer> sliceConfig) {
        var configurer = EventSourcingConfigurer.create();
        configurer = sliceConfig.apply(configurer);
        return AxonTestFixture.with(configurer, c -> c.disableAxonServer());
    }

    private TestFixtures() {}
}
