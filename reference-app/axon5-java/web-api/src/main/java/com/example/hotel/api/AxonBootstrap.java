package com.example.hotel.api;

import com.example.hotel.EventModelModule;
import io.quarkus.runtime.ShutdownEvent;
import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import org.axonframework.axonserver.connector.AxonServerConfiguration;
import org.axonframework.common.configuration.AxonConfiguration;
import org.axonframework.eventsourcing.configuration.EventSourcingConfigurer;
import org.axonframework.messaging.commandhandling.gateway.CommandGateway;
import org.eclipse.microprofile.config.inject.ConfigProperty;

import java.util.concurrent.atomic.AtomicReference;

/**
 * The single CDI-touching class in the web-api. Boots the Axon configuration
 * at startup, exposes the {@link CommandGateway} via a static holder so JAX-RS
 * resources can dispatch commands without DI injection.
 */
@ApplicationScoped
public class AxonBootstrap {

    private static final AtomicReference<CommandGateway> GATEWAY = new AtomicReference<>();

    @ConfigProperty(name = "axon.server.host", defaultValue = "localhost")
    String axonServerHost;

    @ConfigProperty(name = "axon.server.port", defaultValue = "8124")
    int axonServerPort;

    @ConfigProperty(name = "axon.server.context", defaultValue = "default")
    String axonContext;

    private AxonConfiguration axon;

    void onStart(@Observes StartupEvent event) {
        var configurer = EventSourcingConfigurer.create();
        configurer.componentRegistry(r -> r.registerComponent(AxonServerConfiguration.class, c -> {
            var cfg = new AxonServerConfiguration();
            cfg.setServers(axonServerHost + ":" + axonServerPort);
            cfg.setContext(axonContext);
            return cfg;
        }));
        configurer = EventModelModule.contribute(configurer);
        axon = configurer.start();
        GATEWAY.set(axon.getComponent(CommandGateway.class));
    }

    void onStop(@Observes ShutdownEvent event) {
        if (axon != null) {
            axon.shutdown();
        }
        GATEWAY.set(null);
    }

    public static CommandGateway gateway() {
        var gw = GATEWAY.get();
        if (gw == null) {
            throw new IllegalStateException("Axon is not started");
        }
        return gw;
    }
}
