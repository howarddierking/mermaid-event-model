package com.example.hotel.addroom;

import com.example.hotel.TestFixtures;
import com.example.hotel.shared.HotelModelException;
import org.axonframework.test.fixture.AxonTestFixture;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Mirrors the sliceTests in blueprint_dsl_dcb-slices/add-room.md:
 *   - test["Add a room to empty inventory"]   → addRoomToEmptyInventory
 *   - test["Reject duplicate room number"]    → rejectDuplicateRoomNumber
 *
 * Each "then" event maps to an .events / .eventsSatisfy expectation. Each
 * "then" error["..."] maps to .exception(HotelModelException.class, "...").
 */
class AddRoomTest {

    private AxonTestFixture fixture;

    @BeforeEach
    void setUp() {
        fixture = TestFixtures.slice(AddRoomConfiguration::configure);
    }

    @AfterEach
    void tearDown() {
        fixture.stop();
    }

    @Test
    void addRoomToEmptyInventory() {
        fixture.given()
                .noPriorActivity()
                .when()
                .command(new AddRoom(101, 1, "single", 2))
                .then()
                .success()
                .eventsSatisfy(events -> {
                    assertThat(events).hasSize(1);
                    var payload = (RoomAdded) events.get(0).payload();
                    assertThat(payload.roomId()).isNotNull();
                    assertThat(payload.roomNumber()).isEqualTo(101);
                    assertThat(payload.floor()).isEqualTo(1);
                    assertThat(payload.roomType()).isEqualTo("single");
                    assertThat(payload.capacity()).isEqualTo(2);
                });
    }

    @Test
    void rejectDuplicateRoomNumber() {
        fixture.given()
                .event(new RoomAdded(UUID.randomUUID(), 101, 1, "single", 2))
                .when()
                .command(new AddRoom(101, 1, "single", 2))
                .then()
                .exception(HotelModelException.class, "Room with roomNumber already exists");
    }
}
