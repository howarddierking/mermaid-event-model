package com.example.hotel.api;

import com.example.hotel.addroom.AddRoom;
import com.example.hotel.shared.HotelModelException;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/rooms")
public class RoomResource {

    public record AddRoomRequest(int roomNumber, int floor, String roomType, int capacity) {}

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response add(AddRoomRequest req) {
        try {
            AxonBootstrap.gateway().sendAndWait(
                    new AddRoom(req.roomNumber(), req.floor(), req.roomType(), req.capacity())
            );
            return Response.status(Response.Status.CREATED).build();
        } catch (HotelModelException e) {
            return Response.status(Response.Status.CONFLICT)
                    .entity(e.getMessage())
                    .build();
        }
    }
}
