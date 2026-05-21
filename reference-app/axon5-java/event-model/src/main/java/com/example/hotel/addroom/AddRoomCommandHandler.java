package com.example.hotel.addroom;

import com.example.hotel.shared.HotelModelException;
import com.example.hotel.shared.HotelTags;
import org.axonframework.eventsourcing.annotation.EventCriteriaBuilder;
import org.axonframework.eventsourcing.annotation.EventSourcedEntity;
import org.axonframework.eventsourcing.annotation.EventSourcingHandler;
import org.axonframework.eventsourcing.annotation.reflection.EntityCreator;
import org.axonframework.messaging.commandhandling.annotation.CommandHandler;
import org.axonframework.messaging.eventhandling.gateway.EventAppender;
import org.axonframework.messaging.eventstreaming.EventCriteria;
import org.axonframework.messaging.eventstreaming.Tag;
import org.axonframework.modelling.annotation.InjectEntity;

import java.util.UUID;

class AddRoomCommandHandler {

    @CommandHandler
    void handle(AddRoom command, @InjectEntity State state, EventAppender appender) {
        if (state.exists) {
            throw new HotelModelException("Room with roomNumber already exists");
        }
        appender.append(new RoomAdded(
                UUID.randomUUID(),
                command.roomNumber(),
                command.floor(),
                command.roomType(),
                command.capacity()
        ));
    }

    @EventSourcedEntity
    static class State {

        private boolean exists = false;

        @EntityCreator
        public State() {}

        @EventSourcingHandler
        void evolve(RoomAdded event) {
            this.exists = true;
        }

        @EventCriteriaBuilder
        private static EventCriteria resolveCriteria(RoomNumber id) {
            return EventCriteria
                    .havingTags(Tag.of(HotelTags.ROOM_NUMBER, String.valueOf(id.value())))
                    .andBeingOneOfTypes(RoomAdded.class.getName());
        }
    }
}
