package com.example.hotel.addroom;

import org.axonframework.modelling.annotation.TargetEntityId;

public record AddRoom(int roomNumber, int floor, String roomType, int capacity) {

    @TargetEntityId
    private RoomNumber id() {
        return new RoomNumber(roomNumber);
    }
}
