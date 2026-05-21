package com.example.hotel.addroom;

import com.example.hotel.shared.HotelTags;
import org.axonframework.eventsourcing.annotation.EventTag;

import java.util.UUID;

public record RoomAdded(
        UUID roomId,
        @EventTag(key = HotelTags.ROOM_NUMBER)
        int roomNumber,
        int floor,
        String roomType,
        int capacity
) {}
